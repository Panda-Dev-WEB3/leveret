//! Squared perps end to end: ShortVault mint at 200%, AMM seeded with backed
//! PowerTokens, longs buy and sell inside the oracle band, sells never fill
//! under `I(1 − b)`, shorts burn and withdraw.

use lvrt_common::{lvrt_math::oracle::source, Family};
use lvrt_oracle::{FeedParams, SignerKind};
use lvrt_power::{accounts as acc, instruction as ins, PowerKind, PowerMarket, ShortVault};
use lvrt_tests::{oracle, *};

const SOL: u32 = 1;
const MKT: u32 = 1;
const USD: i64 = 100_000_000;
const USDC: u64 = 1_000_000;
const TOKEN: u64 = 1_000_000;

fn cfg() -> Pubkey {
    pda(&[seeds::CONFIG], &lvrt_power::ID)
}
fn market() -> Pubkey {
    pda(&[seeds::POWER, &MKT.to_le_bytes()], &lvrt_power::ID)
}
fn power_mint() -> Pubkey {
    pda(&[seeds::POWER_MINT, &MKT.to_le_bytes()], &lvrt_power::ID)
}
fn usdc_vault() -> Pubkey {
    pda(&[seeds::CUSTODY, &MKT.to_le_bytes()], &lvrt_power::ID)
}
fn token_vault() -> Pubkey {
    pda(&[seeds::POWER, b"amm", &MKT.to_le_bytes()], &lvrt_power::ID)
}
fn short_vault(owner: &Pubkey) -> Pubkey {
    pda(&[seeds::SHORT_VAULT, market().as_ref(), owner.as_ref()], &lvrt_power::ID)
}

struct T {
    env: Env,
    pusher_a: Keypair,
    pusher_b: Keypair,
}

impl T {
    fn new() -> Self {
        let mut env = Env::new();
        oracle::initialize(&mut env);
        let pusher_a = Keypair::new();
        let pusher_b = Keypair::new();
        oracle::register(&mut env, &pusher_a.pubkey(), source::CHAINLINK, SignerKind::Pusher);
        oracle::register(&mut env, &pusher_b.pubkey(), source::SWITCHBOARD, SignerKind::Pusher);
        oracle::create_feed(
            &mut env,
            FeedParams {
                market_id: SOL,
                family: Family::Core,
                symbol: [0; 16],
                allowed_sources: 0b11,
                min_sources: 2,
                max_dev_bps: 50,
                fresh_ms: 800,
                band_limit_bps: 500,
                normal_band_bps: 10,
                chainlink_feed_id: [0; 32],
                switchboard_feed_id: [0; 32],
                min_source_depth_usd: 0,
                measured_source_depth_usd: 0,
            },
        );

        let d = env.deployer.insecure_clone();
        let i = ix(
            lvrt_power::ID,
            ins::Initialize { authority: env.authority.pubkey(), guardian: env.guardian.pubkey() },
            acc::Initialize {
                payer: d.pubkey(),
                config: cfg(),
                program: lvrt_power::ID,
                program_data: program_data_address(&lvrt_power::ID),
                system_program: SYSTEM,
            },
            vec![],
        );
        env.ok(&[i], &[&d]);

        let mut t = T { env, pusher_a, pusher_b };
        let q = t.quote(150 * USD);
        t.env.ok(&q, &[&d]);
        let a = t.env.authority.insecure_clone();
        let i = ix(
            lvrt_power::ID,
            ins::CreatePowerMarket { id: MKT, kind: PowerKind::Squared, price_state_2: Pubkey::default() },
            acc::CreatePowerMarket {
                payer: a.pubkey(),
                authority: a.pubkey(),
                config: cfg(),
                market: market(),
                price_state: oracle::price(SOL),
                power_mint: power_mint(),
                usdc_mint: USDC_MINT,
                usdc_vault: usdc_vault(),
                token_vault: token_vault(),
                power_token_program: TOKEN_2022,
                usdc_token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        );
        t.env.ok(&[i], &[&a]);
        t
    }

    fn quote(&self, mid: i64) -> Vec<Instruction> {
        let ts = self.env.now() * 1_000 + 500;
        oracle::post_ixs(
            SOL,
            &[(&self.pusher_a, price_msg(SOL, mid, USD / 100, ts, 0, false)), (&self.pusher_b, price_msg(SOL, mid, USD / 100, ts, 0, false))],
        )
    }

    fn with_quote(&mut self, mid: i64, i: Instruction) -> Vec<Instruction> {
        self.env.advance(1);
        let mut v = self.quote(mid);
        v.push(i);
        v
    }

    fn short_ix(&self, owner: &Pubkey, owner_power: &Pubkey, owner_usdc: &Pubkey, data: impl InstructionData) -> Instruction {
        ix(
            lvrt_power::ID,
            data,
            acc::MintShort {
                owner: *owner,
                market: market(),
                price_state: oracle::price(SOL),
                short_vault: short_vault(owner),
                power_mint: power_mint(),
                owner_power: *owner_power,
                usdc_mint: USDC_MINT,
                owner_usdc: *owner_usdc,
                usdc_vault: usdc_vault(),
                power_token_program: TOKEN_2022,
                usdc_token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        )
    }

    fn amm_ix(&self, user: &Pubkey, user_power: &Pubkey, user_usdc: &Pubkey, data: impl InstructionData) -> Instruction {
        ix(
            lvrt_power::ID,
            data,
            acc::AmmTrade {
                user: *user,
                market: market(),
                price_state: oracle::price(SOL),
                price_state_2: None,
                power_mint: power_mint(),
                user_power: *user_power,
                token_vault: token_vault(),
                usdc_mint: USDC_MINT,
                user_usdc: *user_usdc,
                usdc_vault: usdc_vault(),
                power_token_program: TOKEN_2022,
                usdc_token_program: SPL_TOKEN,
            },
            vec![],
        )
    }

    fn seed_ix(&self, auth_power: &Pubkey, auth_usdc: &Pubkey, usdc_in: u64, tokens_in: u64) -> Instruction {
        ix(
            lvrt_power::ID,
            ins::SeedAmm { usdc_in, tokens_in },
            acc::SeedAmm {
                authority: self.env.authority.pubkey(),
                config: cfg(),
                market: market(),
                price_state: oracle::price(SOL),
                price_state_2: None,
                power_mint: power_mint(),
                authority_power: *auth_power,
                token_vault: token_vault(),
                usdc_mint: USDC_MINT,
                authority_usdc: *auth_usdc,
                usdc_vault: usdc_vault(),
                power_token_program: TOKEN_2022,
                usdc_token_program: SPL_TOKEN,
            },
            vec![],
        )
    }

    /// Authority mints 20 tokens at 222% and seeds the AMM at the index
    /// (S = 150 → I = 22,500 per token).
    fn seeded(mut self) -> (Self, Pubkey, Pubkey) {
        let a = self.env.authority.insecure_clone();
        let a_usdc = self.env.usdc_account(&a.pubkey(), 2_000_000 * USDC);
        let a_power = self.env.token_account(&power_mint(), &a.pubkey(), &TOKEN_2022);
        let m = self.short_ix(&a.pubkey(), &a_power, &a_usdc, ins::MintShort { collateral_in: 1_000_000 * USDC, mint_amount: 20 * TOKEN });
        let txs = self.with_quote(150 * USD, m);
        self.env.ok(&txs, &[&a]);
        // a seed priced 5% off the index is refused
        let bad = self.seed_ix(&a_power, &a_usdc, 427_500 * USDC, 20 * TOKEN);
        let txs = self.with_quote(150 * USD, bad);
        self.env.fails_with(&txs, &[&a], "OutsideBand");
        let s = self.seed_ix(&a_power, &a_usdc, 450_000 * USDC, 20 * TOKEN);
        let txs = self.with_quote(150 * USD, s);
        self.env.ok(&txs, &[&a]);
        (self, a_power, a_usdc)
    }
}

#[test]
fn shorts_seed_the_amm_and_longs_round_trip_inside_the_band() {
    let (mut t, _, _) = T::new().seeded();
    let m: PowerMarket = t.env.account(&market());
    assert_eq!((m.amm_usdc, m.amm_tokens), (450_000 * USDC, 20 * TOKEN));
    assert_eq!(t.env.token_balance(&token_vault()), 20 * TOKEN);
    assert_eq!(t.env.token_balance(&usdc_vault()), 1_450_000 * USDC);

    // a long buys $2,000 at ~the index (0.44% curve impact, inside the 1% band)
    let trader = t.env.funded();
    let t_usdc = t.env.usdc_account(&trader.pubkey(), 10_000 * USDC);
    let t_power = t.env.token_account(&power_mint(), &trader.pubkey(), &TOKEN_2022);
    let b = t.amm_ix(&trader.pubkey(), &t_power, &t_usdc, ins::AmmBuy { usdc_in: 2_000 * USDC, min_tokens_out: 0 });
    let txs = t.with_quote(150 * USD, b);
    t.env.ok(&txs, &[&trader]);
    let bought = t.env.token_balance(&t_power);
    // y · net / (x + net) = 20 · 1,998 / 451,998 tokens
    assert!(bought > 88_000 && bought < 89_000, "bought {bought}");

    // slippage bound is enforced (the pool now sits ~0.9% over the index, so keep it small)
    let b = t.amm_ix(&trader.pubkey(), &t_power, &t_usdc, ins::AmmBuy { usdc_in: 200 * USDC, min_tokens_out: 50_000 });
    let txs = t.with_quote(150 * USD, b);
    t.env.fails_with(&txs, &[&trader], "Slippage");

    // S +1% → I +2%: the pool now quotes under the band; the sell fills at the floor
    let s = t.amm_ix(&trader.pubkey(), &t_power, &t_usdc, ins::AmmSell { tokens_in: bought, min_usdc_out: 0 });
    let txs = t.with_quote(151_50_000_000, s);
    t.env.ok(&txs, &[&trader]);
    let back = t.env.token_balance(&t_usdc) - 8_000 * USDC;
    let m: PowerMarket = t.env.account(&market());
    let index = 151_50_000_000i128 * 151_50_000_000 / USD as i128;
    let floor = (bought as i128 * (index - index / 100) / USD as i128) * m.norm_factor as i128 / lvrt_common::lvrt_math::NORM_SCALE;
    assert!(back as i128 >= floor - floor / 1_000 - 1, "back {back} < floor {floor}");
    assert!(back > 2_000 * USDC, "a 2% index rise should pay the long: {back}");
    assert_eq!(t.env.token_balance(&t_power), 0);
    assert_eq!(m.amm_tokens, 20 * TOKEN);
}

#[test]
fn buys_above_the_band_route_to_the_short_vault() {
    let (mut t, _, _) = T::new().seeded();
    let trader = t.env.funded();
    let t_usdc = t.env.usdc_account(&trader.pubkey(), 10_000 * USDC);
    let t_power = t.env.token_account(&power_mint(), &trader.pubkey(), &TOKEN_2022);
    // S −2% → I −4%: the pool's ~22,500 is above I(1 + 1%) ≈ 21,825
    let b = t.amm_ix(&trader.pubkey(), &t_power, &t_usdc, ins::AmmBuy { usdc_in: 1_000 * USDC, min_tokens_out: 0 });
    let txs = t.with_quote(147 * USD, b);
    t.env.fails_with(&txs, &[&trader], "OutsideBand");
}

#[test]
fn short_vault_mints_at_200_and_burns_back_to_zero() {
    let (mut t, _, _) = T::new().seeded();
    let s = t.env.funded();
    let s_usdc = t.env.usdc_account(&s.pubkey(), 100_000 * USDC);
    let s_power = t.env.token_account(&power_mint(), &s.pubkey(), &TOKEN_2022);

    // 1 token = $22,500 debt: $44,000 collateral is under 200%
    let m = t.short_ix(&s.pubkey(), &s_power, &s_usdc, ins::MintShort { collateral_in: 44_000 * USDC, mint_amount: TOKEN });
    let txs = t.with_quote(150 * USD, m);
    t.env.fails_with(&txs, &[&s], "Undercollateralized");
    let m = t.short_ix(&s.pubkey(), &s_power, &s_usdc, ins::MintShort { collateral_in: 46_000 * USDC, mint_amount: TOKEN });
    let txs = t.with_quote(150 * USD, m);
    t.env.ok(&txs, &[&s]);
    assert_eq!(t.env.token_balance(&s_power), TOKEN);
    let v: ShortVault = t.env.account(&short_vault(&s.pubkey()));
    assert_eq!((v.collateral, v.minted), (46_000 * USDC, TOKEN));

    // withdrawing below 150% is refused; burning everything frees all collateral
    let b = t.short_ix(&s.pubkey(), &s_power, &s_usdc, ins::BurnShort { burn_amount: 0, collateral_out: 13_000 * USDC });
    let txs = t.with_quote(150 * USD, b);
    t.env.fails_with(&txs, &[&s], "Undercollateralized");
    let b = t.short_ix(&s.pubkey(), &s_power, &s_usdc, ins::BurnShort { burn_amount: TOKEN, collateral_out: 46_000 * USDC });
    let txs = t.with_quote(150 * USD, b);
    t.env.ok(&txs, &[&s]);
    assert_eq!(t.env.token_balance(&s_usdc), 100_000 * USDC);
    assert_eq!(t.env.token_balance(&s_power), 0);
    let m: PowerMarket = t.env.account(&market());
    assert_eq!(m.public_short_minted, 20 * TOKEN);
}
