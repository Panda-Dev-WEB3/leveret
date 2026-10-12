//! §10 Twins: mint opens a 1× engine long through the vault's own margin
//! account at the engine's fill, redeem closes that slice and pays its exit
//! fill; redemption is never gated by a pause; the vault stays ≥ 1× backed.

use lvrt_common::{seeds, Side};
use lvrt_engine::{MarginAccount, Position};
use lvrt_tests::{engine, fixture::*, oracle, *};
use lvrt_twins::{accounts as acc, instruction as ins, TwinVault};

const SYM: [u8; 8] = *b"lSOL\0\0\0\0";

fn cfg() -> Pubkey {
    pda(&[seeds::CONFIG], &lvrt_twins::ID)
}
fn twin() -> Pubkey {
    pda(&[seeds::TWIN, &SYM], &lvrt_twins::ID)
}
fn signer() -> Pubkey {
    pda(&[seeds::TWIN_SIGNER, &SYM], &lvrt_twins::ID)
}
fn mint() -> Pubkey {
    pda(&[seeds::TWIN_MINT, &SYM], &lvrt_twins::ID)
}
fn buffer() -> Pubkey {
    pda(&[seeds::CUSTODY, &SYM], &lvrt_twins::ID)
}
fn margin() -> Pubkey {
    engine::margin(&signer(), 0)
}
fn position() -> Pubkey {
    engine::position(&margin(), SOL, Side::Long)
}

struct T {
    c: Core,
    user: Keypair,
    user_usdc: Pubkey,
    user_twin: Pubkey,
}

impl T {
    fn new() -> Self {
        let mut c = Core::new();
        c.post(150 * USD);
        let d = c.env.deployer.insecure_clone();
        let i = ix(
            lvrt_twins::ID,
            ins::Initialize { authority: c.env.authority.pubkey(), guardian: c.env.guardian.pubkey() },
            acc::Initialize { payer: d.pubkey(), config: cfg(), program: lvrt_twins::ID, program_data: program_data_address(&lvrt_twins::ID), system_program: SYSTEM },
            vec![],
        );
        c.env.ok(&[i], &[&d]);
        let a = c.env.authority.insecure_clone();
        let i = ix(
            lvrt_twins::ID,
            ins::CreateTwin { symbol: SYM, market_id: SOL, fee_bps: 10, holding_fee_threshold: 0 },
            acc::CreateTwin {
                payer: a.pubkey(),
                authority: a.pubkey(),
                config: cfg(),
                twin: twin(),
                twin_signer: signer(),
                price_state: oracle::price(SOL),
                engine_market: engine::market(SOL),
                mint: mint(),
                usdc_mint: USDC_MINT,
                usdc_buffer: buffer(),
                engine_margin: margin(),
                engine_program: lvrt_engine::ID,
                twin_token_program: TOKEN_2022,
                usdc_token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        );
        c.env.ok(&[i], &[&a]);
        // custody is shared by every margin in its shard and refilled from the
        // LLP bucket by settle_shard; stand in for both so profitable
        // redemptions can be paid out here
        for k in 0..engine::CUSTODY_COUNT {
            c.env.put_usdc(&engine::custody(k), &engine::signer(), 100_000 * USDC);
        }
        let user = c.env.funded();
        let user_usdc = c.env.usdc_account(&user.pubkey(), 10_000 * USDC);
        let user_twin = c.env.token_account(&mint(), &user.pubkey(), &TOKEN_2022);
        T { c, user, user_usdc, user_twin }
    }

    fn accounts(&self) -> acc::MintRedeem {
        let m = margin();
        acc::MintRedeem {
            user: self.user.pubkey(),
            twin: twin(),
            twin_signer: signer(),
            mint: mint(),
            user_twin: self.user_twin,
            usdc_mint: USDC_MINT,
            user_usdc: self.user_usdc,
            usdc_buffer: buffer(),
            engine_config: engine::config(),
            engine_signer: engine::signer(),
            engine_margin: m,
            engine_custody: engine::custody(engine::shard_of(&m, engine::CUSTODY_COUNT)),
            engine_market: engine::market(SOL),
            funding_state: engine::funding(SOL),
            price_state: oracle::price(SOL),
            shard: engine::shard(SOL, engine::shard_of(&m, engine::SHARDS)),
            position: position(),
            engine_program: lvrt_engine::ID,
            twin_token_program: TOKEN_2022,
            usdc_token_program: SPL_TOKEN,
            system_program: SYSTEM,
        }
    }

    fn priced(&mut self, mid: i64, i: Instruction) -> Vec<Instruction> {
        self.c.env.advance(1);
        let mut v = self.c.quote(mid);
        v.push(i);
        v
    }

    fn mint_ix(&self, twins: u64, max_usdc_in: u64) -> Instruction {
        ix(lvrt_twins::ID, ins::Mint { twins, max_usdc_in }, self.accounts(), vec![])
    }

    fn redeem_ix(&self, twins_in: u64, min_usdc_out: u64) -> Instruction {
        ix(lvrt_twins::ID, ins::Redeem { twins_in, min_usdc_out }, self.accounts(), vec![])
    }

    fn usdc(&self) -> u64 {
        self.c.env.token_balance(&self.user_usdc)
    }
}

#[test]
fn mint_opens_a_1x_long_and_redeem_pays_the_exit_fill() {
    let mut t = T::new();
    let u = t.user.insecure_clone();
    let v: TwinVault = t.c.env.account(&twin());
    assert_eq!(v.engine_margin, margin());
    let m: MarginAccount = t.c.env.account(&margin());
    assert_eq!(m.owner, signer());

    // a cap below the cost is refused
    let i = t.mint_ix(10 * UNIT, 1_400 * USDC);
    let txs = t.priced(150 * USD, i);
    t.c.env.fails_with(&txs, &[&u], "Slippage");

    // 10 twins at ~150: the engine's fill + its fee + 10 bps twin fee
    let before = t.usdc();
    let i = t.mint_ix(10 * UNIT, 1_600 * USDC);
    let txs = t.priced(150 * USD, i);
    t.c.env.ok(&txs, &[&u]);
    let paid = before - t.usdc();
    assert!(paid > 1_500 * USDC && paid < 1_505 * USDC, "paid {paid}");
    assert_eq!(t.c.env.token_balance(&t.user_twin), 10 * UNIT);
    let p: Position = t.c.env.account(&position());
    assert_eq!(p.size, 10 * UNIT);
    // the vault's margin holds what the user paid less the engine fee: ≥ 1× backed
    let m: MarginAccount = t.c.env.account(&margin());
    assert!(m.collateral as u64 >= p.entry_notional, "collateral {} < entry {}", m.collateral, p.entry_notional);

    // the price rises 10% (held past the 10 s anti-staleness window): redeem 4 at the exit fill
    t.c.env.advance(15);
    let before = t.usdc();
    let i = t.redeem_ix(4 * UNIT, 650 * USDC);
    let txs = t.priced(165 * USD, i);
    t.c.env.ok(&txs, &[&u]);
    let got = t.usdc() - before;
    // 4 × ~164.2 (bid side) less fees
    assert!(got > 650 * USDC && got < 660 * USDC, "got {got}");
    assert_eq!(t.c.env.token_balance(&t.user_twin), 6 * UNIT);
    let p: Position = t.c.env.account(&position());
    assert_eq!(p.size, 6 * UNIT);

    // a floor above the payout is refused
    let i = t.redeem_ix(6 * UNIT, 2_000 * USDC);
    let txs = t.priced(165 * USD, i);
    t.c.env.fails_with(&txs, &[&u], "Slippage");

    // redeem the rest: the long is closed, the fees stay as surplus
    let i = t.redeem_ix(6 * UNIT, 0);
    let txs = t.priced(165 * USD, i);
    t.c.env.ok(&txs, &[&u]);
    assert_eq!(t.c.env.token_balance(&t.user_twin), 0);
    assert!(!t.c.env.exists(&position()));
    let m: MarginAccount = t.c.env.account(&margin());
    assert!(m.collateral > 0, "the twin fees stay in the vault: {}", m.collateral);
    assert_eq!(m.open_positions, 0);
}

/// A redeem seconds after a mint gets the engine's anti-staleness haircut on
/// its profit; the payout is capped at what the slice released, so the
/// remaining holders stay fully backed.
#[test]
fn a_quick_round_trip_bears_its_own_haircut() {
    let mut t = T::new();
    let u = t.user.insecure_clone();
    let i = t.mint_ix(10 * UNIT, 1_600 * USDC);
    let txs = t.priced(150 * USD, i);
    t.c.env.ok(&txs, &[&u]);
    for k in 0..2 {
        let i = t.redeem_ix(5 * UNIT, 0);
        let txs = t.priced(156 * USD, i);
        t.c.env.ok(&txs, &[&u]);
        let m: MarginAccount = t.c.env.account(&margin());
        assert!(m.collateral >= 0, "round {k}: collateral {}", m.collateral);
    }
    assert_eq!(t.c.env.token_balance(&t.user_twin), 0);
    assert!(!t.c.env.exists(&position()));
}

#[test]
fn redemption_is_never_gated_by_a_pause() {
    let mut t = T::new();
    let u = t.user.insecure_clone();
    let i = t.mint_ix(5 * UNIT, 800 * USDC);
    let txs = t.priced(150 * USD, i);
    t.c.env.ok(&txs, &[&u]);

    let g = t.c.env.guardian.insecure_clone();
    t.c.env.ok(&[engine::set_paused_ix(&g.pubkey(), true)], &[&g]);
    let i = t.mint_ix(UNIT, 200 * USDC);
    let txs = t.priced(150 * USD, i);
    t.c.env.fails_with(&txs, &[&u], "OpensPaused");

    let i = t.redeem_ix(5 * UNIT, 0);
    let txs = t.priced(150 * USD, i);
    t.c.env.ok(&txs, &[&u]);
    assert_eq!(t.c.env.token_balance(&t.user_twin), 0);
}

#[test]
fn only_the_authority_creates_twins() {
    let mut c = Core::new();
    c.post(150 * USD);
    let d = c.env.deployer.insecure_clone();
    let i = ix(
        lvrt_twins::ID,
        ins::Initialize { authority: c.env.authority.pubkey(), guardian: c.env.guardian.pubkey() },
        acc::Initialize { payer: d.pubkey(), config: cfg(), program: lvrt_twins::ID, program_data: program_data_address(&lvrt_twins::ID), system_program: SYSTEM },
        vec![],
    );
    c.env.ok(&[i], &[&d]);
    let x = c.env.funded();
    let i = ix(
        lvrt_twins::ID,
        ins::CreateTwin { symbol: SYM, market_id: SOL, fee_bps: 10, holding_fee_threshold: 0 },
        acc::CreateTwin {
            payer: x.pubkey(),
            authority: x.pubkey(),
            config: cfg(),
            twin: twin(),
            twin_signer: signer(),
            price_state: oracle::price(SOL),
            engine_market: engine::market(SOL),
            mint: mint(),
            usdc_mint: USDC_MINT,
            usdc_buffer: buffer(),
            engine_margin: margin(),
            engine_program: lvrt_engine::ID,
            twin_token_program: TOKEN_2022,
            usdc_token_program: SPL_TOKEN,
            system_program: SYSTEM,
        },
        vec![],
    );
    c.env.fails_with(&[i], &[&x], "NotAuthority");
}
