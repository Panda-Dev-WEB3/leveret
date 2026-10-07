//! §14 fixture: a ticket can't survive a crossing report submitted late.

use lvrt_common::{lvrt_math::oracle::source, Family, Side};
use lvrt_oracle::{FeedParams, SignerKind};
use lvrt_tests::{oracle, *};
use lvrt_tickets::{accounts as acc, instruction as ins, Ticket, TicketMarketParams};

const SOL: u32 = 1;
const USD: i64 = 100_000_000;
const USDC: u64 = 1_000_000;

fn cfg() -> Pubkey {
    pda(&[seeds::CONFIG], &lvrt_tickets::ID)
}
fn vault() -> Pubkey {
    pda(&[seeds::CUSTODY], &lvrt_tickets::ID)
}
fn market(id: u32) -> Pubkey {
    pda(&[seeds::MARKET, &id.to_le_bytes()], &lvrt_tickets::ID)
}
fn ticket(owner: &Pubkey, nonce: u64) -> Pubkey {
    pda(&[seeds::TICKET, owner.as_ref(), &nonce.to_le_bytes()], &lvrt_tickets::ID)
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
                band_limit_bps: 200,
                normal_band_bps: 10,
                chainlink_feed_id: [0; 32],
                switchboard_feed_id: [0; 32],
                min_source_depth_usd: 0,
                measured_source_depth_usd: 0,
            },
        );

        let d = env.deployer.insecure_clone();
        let i = ix(
            lvrt_tickets::ID,
            ins::Initialize { authority: env.authority.pubkey(), guardian: env.guardian.pubkey() },
            acc::Initialize {
                payer: d.pubkey(),
                config: cfg(),
                usdc_mint: USDC_MINT,
                vault: vault(),
                program: lvrt_tickets::ID,
                program_data: program_data_address(&lvrt_tickets::ID),
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        );
        env.ok(&[i], &[&d]);
        // seed TICKETS bucket liquidity
        env.put_usdc(&vault(), &vault(), 10_000 * USDC);

        let a = env.authority.insecure_clone();
        let i = ix(
            lvrt_tickets::ID,
            ins::CreateTicketMarket {
                p: TicketMarketParams {
                    market_id: SOL,
                    fresh_ms: 800,
                    base_rate: 50_000_000_000, // 5%/yr
                    spread_long: 20_000_000_000,
                    spread_short: 20_000_000_000,
                    spread_bps: 20,
                    half_spread_bps: 5,
                    gap_premium_bps: 10,
                    gap_premium_off_hours_bps: 50,
                    net_cap_bps: 10_000,
                    gross_cap: 1_000_000 * USDC,
                },
            },
            acc::CreateTicketMarket {
                payer: a.pubkey(),
                authority: a.pubkey(),
                config: cfg(),
                market: market(SOL),
                price_state: oracle::price(SOL),
                system_program: SYSTEM,
            },
            vec![],
        );
        env.ok(&[i], &[&a]);
        T { env, pusher_a, pusher_b }
    }

    fn quote(&self, mid: i64) -> Vec<Instruction> {
        let ts = self.env.now() * 1_000 + 500;
        oracle::post_ixs(
            SOL,
            &[(&self.pusher_a, price_msg(SOL, mid, USD / 100, ts, 0, false)), (&self.pusher_b, price_msg(SOL, mid, USD / 100, ts, 0, false))],
        )
    }

    fn buy_ix(&self, buyer: &Pubkey, usdc: &Pubkey, nonce: u64, barrier: i64, max_price: u64) -> Instruction {
        ix(
            lvrt_tickets::ID,
            ins::Buy { nonce, side: Side::Long, r: 1_000_000, barrier, max_price },
            acc::Buy {
                buyer: *buyer,
                config: cfg(),
                market: market(SOL),
                price_state: oracle::price(SOL),
                ticket: ticket(buyer, nonce),
                usdc_mint: USDC_MINT,
                buyer_usdc: *usdc,
                vault: vault(),
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        )
    }

    fn knock_out_ix(&self, t: &Pubkey, owner: &Pubkey, evidence_key: Option<Pubkey>) -> Instruction {
        ix(
            lvrt_tickets::ID,
            ins::KnockOut {},
            acc::KnockOut { market: market(SOL), price_state: oracle::price(SOL), ticket: *t, owner: *owner, instructions: IX_SYSVAR },
            evidence_key.map(|k| vec![AccountMeta::new_readonly(oracle::signer_key(&k), false)]).unwrap_or_default(),
        )
    }
}

#[test]
fn buy_prices_the_ticket_and_enforces_distance() {
    let mut t = T::new();
    let buyer = t.env.funded();
    let usdc = t.env.usdc_account(&buyer.pubkey(), 1_000 * USDC);

    // 1.3% away: below the 3% in-session minimum
    let mut ixs = t.quote(150 * USD);
    ixs.push(t.buy_ix(&buyer.pubkey(), &usdc, 0, 148 * USD, 100 * USDC));
    t.env.fails_with(&ixs, &[&buyer], "TooClose");

    let mut ixs = t.quote(150 * USD);
    ixs.push(t.buy_ix(&buyer.pubkey(), &usdc, 0, 140 * USD, 11 * USDC));
    t.env.ok(&ixs, &[&buyer]);
    // V(S_ask) = 150.075 − 140 = 10.075; + 20 bps spread 0.30 + 10 bps gap 0.15
    assert_eq!(t.env.token_balance(&usdc), 1_000 * USDC - 10_525_000);
    let tk: Ticket = t.env.account(&ticket(&buyer.pubkey(), 0));
    assert_eq!(tk.f_initial, 140 * USD);
}

#[test]
fn late_crossing_report_knocks_the_ticket_out() {
    let mut t = T::new();
    let buyer = t.env.funded();
    let usdc = t.env.usdc_account(&buyer.pubkey(), 1_000 * USDC);
    let mut ixs = t.quote(150 * USD);
    ixs.push(t.buy_ix(&buyer.pubkey(), &usdc, 7, 140 * USD, 11 * USDC));
    t.env.ok(&ixs, &[&buyer]);
    let tk_addr = ticket(&buyer.pubkey(), 7);

    // a dip to 139 happens, but nobody posts it
    t.env.advance(30);
    let dip_ts = t.env.now() * 1_000;
    let dip = price_msg(SOL, 139 * USD, USD / 100, dip_ts, 0, false);

    // price recovers and is posted live
    t.env.advance(30);
    let ixs = t.quote(150 * USD);
    let p = t.env.deployer.insecure_clone();
    t.env.ok(&ixs, &[&p]);

    // the live price doesn't cross: no knock-out
    let i = t.knock_out_ix(&tk_addr, &buyer.pubkey(), None);
    t.env.fails_with(&[i], &[&p], "NotCrossed");

    // the late, signed report of the dip is valid evidence
    let ixs = vec![ed25519_ix(&t.pusher_a, &dip), t.knock_out_ix(&tk_addr, &buyer.pubkey(), Some(t.pusher_a.pubkey()))];
    t.env.ok(&ixs, &[&p]);
    assert!(!t.env.exists(&tk_addr), "ticket closed");
}

#[test]
fn evidence_from_before_issue_is_rejected() {
    let mut t = T::new();
    let buyer = t.env.funded();
    let usdc = t.env.usdc_account(&buyer.pubkey(), 1_000 * USDC);
    let early = price_msg(SOL, 139 * USD, USD / 100, (t.env.now() - 60) * 1_000, 0, false);
    let mut ixs = t.quote(150 * USD);
    ixs.push(t.buy_ix(&buyer.pubkey(), &usdc, 1, 140 * USD, 11 * USDC));
    t.env.ok(&ixs, &[&buyer]);
    t.env.advance(5);
    let p = t.env.deployer.insecure_clone();
    let ixs = vec![ed25519_ix(&t.pusher_a, &early), t.knock_out_ix(&ticket(&buyer.pubkey(), 1), &buyer.pubkey(), Some(t.pusher_a.pubkey()))];
    t.env.fails_with(&ixs, &[&p], "BadEvidence");
}
