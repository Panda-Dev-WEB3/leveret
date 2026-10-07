//! End-to-end: oracle → engine fill path, the pause/WIDE/staleness rules,
//! liquidation, withdraw health, shard merge and the 72h timelock.

use lvrt_common::{lvrt_math::oracle::source, Bucket, Family, PriceStatus, Side};
use lvrt_engine::{FundingState, MarginAccount, OpenArgs, Position};
use lvrt_oracle::{FeedParams, PriceState, SignerKind};
use lvrt_tests::{engine, gov, oracle, *};

const SOL: u32 = 1;
const USD: i64 = 100_000_000; // price scale
const USDC: u64 = 1_000_000;
const UNIT: u64 = 1_000_000; // base scale

struct Core {
    env: Env,
    pusher_a: Keypair,
    pusher_b: Keypair,
}

impl Core {
    fn new() -> Self {
        Self::with_engine_authority(None)
    }

    fn with_engine_authority(authority: Option<Pubkey>) -> Self {
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
                symbol: *b"SOL\0\0\0\0\0\0\0\0\0\0\0\0\0",
                allowed_sources: 0b11,
                min_sources: 2,
                max_dev_bps: 50,
                fresh_ms: 800,
                band_limit_bps: 200,
                normal_band_bps: 10,
                chainlink_feed_id: [0; 32],
                switchboard_feed_id: [0; 32],
                min_source_depth_usd: 1_000_000,
                measured_source_depth_usd: 50_000_000,
            },
        );
        let auth = authority.unwrap_or(env.authority.pubkey());
        engine::initialize(&mut env, auth);
        let mut c = Core { env, pusher_a, pusher_b };
        if authority.is_none() {
            engine::create_market(&mut c.env, SOL, Family::Core, Bucket::Core, 800, engine::core_risk());
        }
        c
    }

    /// Both sources sign `mid` at the current time.
    fn quote(&self, mid: i64) -> Vec<Instruction> {
        self.quote_with(mid, true)
    }

    fn quote_with(&self, mid: i64, both: bool) -> Vec<Instruction> {
        let ts = self.env.now() * 1_000 + 500;
        let a = price_msg(SOL, mid, USD / 100, ts, 0, false);
        if both {
            let b = price_msg(SOL, mid, USD / 100, ts, 0, false);
            oracle::post_ixs(SOL, &[(&self.pusher_a, a), (&self.pusher_b, b)])
        } else {
            oracle::post_ixs(SOL, &[(&self.pusher_a, a)])
        }
    }

    fn post(&mut self, mid: i64) {
        let ixs = self.quote(mid);
        let p = self.env.deployer.insecure_clone();
        self.env.ok(&ixs, &[&p]);
    }

    fn post_fails_expired(&mut self) {
        let ixs = self.quote(150 * USD);
        let p = self.env.deployer.insecure_clone();
        self.env.fails_with(&ixs, &[&p], "UnknownSigner");
    }

    fn margin(&self, m: &Pubkey) -> MarginAccount {
        self.env.account(m)
    }
}

fn long(size_units: u64, lev_x: u32, bound: i64) -> OpenArgs {
    OpenArgs { side: Side::Long, size: size_units * UNIT, price_bound: bound, leverage_x100: lev_x * 100, isolated_margin: 0 }
}

#[test]
fn initialize_requires_upgrade_authority() {
    let mut env = Env::new();
    let stranger = env.funded();
    let i = ix(
        lvrt_oracle::ID,
        lvrt_oracle::instruction::Initialize { authority: stranger.pubkey(), guardian: stranger.pubkey() },
        lvrt_oracle::accounts::Initialize {
            payer: stranger.pubkey(),
            config: oracle::config(),
            calendar: oracle::calendar(),
            program: lvrt_oracle::ID,
            program_data: program_data_address(&lvrt_oracle::ID),
            system_program: SYSTEM,
        },
        vec![],
    );
    env.fails_with(&[i], &[&stranger], "Unauthorized");
}

#[test]
fn oracle_needs_two_agreeing_sources_for_live() {
    let mut c = Core::new();
    c.post(150 * USD);
    let ps: PriceState = c.env.account(&oracle::price(SOL));
    assert_eq!(ps.status, PriceStatus::Live);
    assert_eq!(ps.source_mask, 0b11);
    assert_eq!(ps.mid, 150 * USD);

    // one source only → WIDE
    c.env.advance(2);
    let ixs = c.quote_with(151 * USD, false);
    let p = c.env.deployer.insecure_clone();
    c.env.ok(&ixs, &[&p]);
    let ps: PriceState = c.env.account(&oracle::price(SOL));
    assert_eq!(ps.status, PriceStatus::Wide);

    // sources 2% apart → the outlier is dropped → WIDE
    c.env.advance(2);
    let ts = c.env.now() * 1_000 + 500;
    let ixs = oracle::post_ixs(
        SOL,
        &[(&c.pusher_a, price_msg(SOL, 150 * USD, USD / 100, ts, 0, false)), (&c.pusher_b, price_msg(SOL, 153 * USD, USD / 100, ts, 0, false))],
    );
    c.env.ok(&ixs, &[&p]);
    let ps: PriceState = c.env.account(&oracle::price(SOL));
    assert_eq!(ps.status, PriceStatus::Wide);
}

/// §6.2 gap protocol: after a halt, the first fresh price carries a band ≥ 2×
/// normal for 10 minutes and is flagged `at_open`.
#[test]
fn halt_then_resume_applies_gap_protocol() {
    let mut c = Core::new();
    c.post(150 * USD);
    let ps: PriceState = c.env.account(&oracle::price(SOL));
    assert_eq!(ps.band_bps, 0, "no gap protocol on a fresh listing");

    c.env.advance(2);
    let ts = c.env.now() * 1_000 + 500;
    let halt = |k: &Keypair| (k.insecure_clone(), price_msg(SOL, 150 * USD, USD / 100, ts, 0, true));
    let (a, b) = (halt(&c.pusher_a), halt(&c.pusher_b));
    let p = c.env.deployer.insecure_clone();
    c.env.ok(&oracle::post_ixs(SOL, &[(&a.0, a.1), (&b.0, b.1)]), &[&p]);
    let ps: PriceState = c.env.account(&oracle::price(SOL));
    assert_eq!(ps.status, PriceStatus::Halted);

    c.env.advance(60);
    c.post(140 * USD);
    let ps: PriceState = c.env.account(&oracle::price(SOL));
    assert_eq!(ps.status, PriceStatus::Live);
    assert_eq!(ps.band_bps, 20); // 2 × normal_band_bps
    assert!(ps.at_open);

    c.env.advance(11 * 60);
    c.post(141 * USD);
    let ps: PriceState = c.env.account(&oracle::price(SOL));
    assert_eq!(ps.band_bps, 0);
    assert!(!ps.at_open);
}

#[test]
fn unregistered_signer_is_rejected() {
    let mut c = Core::new();
    let rogue = Keypair::new();
    let ts = c.env.now() * 1_000 + 500;
    let mut ixs = oracle::post_ixs(SOL, &[(&rogue, price_msg(SOL, 1, 0, ts, 0, false))]);
    // point the SignerKey slot at a real key PDA while the signature is the rogue's
    let last = ixs.len() - 1;
    ixs[last].accounts.last_mut().unwrap().pubkey = oracle::signer_key(&c.pusher_a.pubkey());
    let p = c.env.deployer.insecure_clone();
    c.env.fails_with(&ixs, &[&p], "Stale"); // no matching signature → no samples
}

/// Price verified inside the user's transaction, then filled in the same tx.
#[test]
fn one_transaction_open_and_close_with_profit() {
    let mut c = Core::new();
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 5_000 * USDC);

    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
    let meta = c.env.ok(&ixs, &[&trader]);
    // §1 budget: open/close ≤ 300k CU including oracle verification
    println!("open incl. 2-source oracle post: {} CU", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed <= 300_000);

    let pos: Position = c.env.account(&engine::position(&m, SOL, Side::Long));
    assert_eq!(pos.size, 10 * UNIT);
    // max(ask, mid·(1 + 5 bps)) = 150.075
    assert_eq!(pos.entry_px, 150 * USD + 150 * USD * 5 / 10_000);
    let after_open = c.margin(&m).collateral;
    assert_eq!(after_open, 5_000 * USDC as i64 - 900_450); // 6 bps of 1500.75

    c.env.advance(20); // beyond the 10s anti-staleness window
    let mut ixs = c.quote(160 * USD);
    ixs.push(engine::close_ix(&trader.pubkey(), &trader.pubkey(), &m, SOL, Side::Long, 0, 159 * USD));
    let meta = c.env.ok(&ixs, &[&trader]);
    println!("close incl. 2-source oracle post: {} CU", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed <= 300_000);

    assert!(!c.env.exists(&engine::position(&m, SOL, Side::Long)), "position account closed");
    let ma = c.margin(&m);
    // exit at min(bid, 160·(1 − 5 bps)) = 159.92; pnl 98.45; fee 0.95952
    assert_eq!(ma.collateral, after_open + 98_450_000 - 959_520);
    assert_eq!(ma.open_positions, 0);
    assert_eq!(ma.im_reserved, 0);
}

#[test]
fn anti_staleness_edge_haircuts_quick_round_trips() {
    let mut c = Core::new();
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 5_000 * USDC);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);
    let after_open = c.margin(&m).collateral;

    c.env.advance(3); // < 10s
    let mut ixs = c.quote(151 * USD);
    ixs.push(engine::close_ix(&trader.pubkey(), &trader.pubkey(), &m, SOL, Side::Long, 0, 150 * USD));
    c.env.ok(&ixs, &[&trader]);
    // pnl = 10 × (150.9245 − 150.075) = 8.495; spread paid 0.75 + 0.755 → hurdle 3× = 4.515
    let fee = 905_547; // 6 bps of 1509.245, rounded up
    assert_eq!(c.margin(&m).collateral, after_open + (8_495_000 - 4_515_000) - fee);
}

#[test]
fn pause_blocks_opens_but_never_exits() {
    let mut c = Core::new();
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 5_000 * USDC);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(5, 5, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);

    let g = c.env.guardian.insecure_clone();
    c.env.ok(&[engine::set_paused_ix(&g.pubkey(), true)], &[&g]);

    c.env.advance(1);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(1, 5, 151 * USD)));
    c.env.fails_with(&ixs, &[&trader], "OpensPaused");

    // exits always open
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::close_ix(&trader.pubkey(), &trader.pubkey(), &m, SOL, Side::Long, 0, 149 * USD));
    c.env.ok(&ixs, &[&trader]);

    // guardian can only tighten; the timelock authority unpauses
    c.env.fails_with(&[engine::set_paused_ix(&g.pubkey(), false)], &[&g], "GuardianCannotLoosen");
    let a = c.env.authority.insecure_clone();
    c.env.ok(&[engine::set_paused_ix(&a.pubkey(), false)], &[&a]);
}

#[test]
fn wide_and_stale_prices_block_opens_but_not_closes() {
    let mut c = Core::new();
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 5_000 * USDC);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(5, 5, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);

    // stale: no fresh print
    c.env.advance(5);
    c.env.fails_with(&[engine::open_ix(&trader.pubkey(), &m, SOL, long(1, 5, 151 * USD))], &[&trader], "StalePrice");

    // WIDE: a single source
    let mut ixs = c.quote_with(150 * USD, false);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(1, 5, 151 * USD)));
    c.env.fails_with(&ixs, &[&trader], "PriceNotLive");

    let mut ixs = c.quote_with(150 * USD, false);
    ixs.push(engine::close_ix(&trader.pubkey(), &trader.pubkey(), &m, SOL, Side::Long, 0, 140 * USD));
    c.env.ok(&ixs, &[&trader]);
}

#[test]
fn leverage_and_slippage_limits() {
    let mut c = Core::new();
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 5_000 * USDC);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(1, 51, 151 * USD)));
    c.env.fails_with(&ixs, &[&trader], "LeverageTooHigh");
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(1, 5, 150 * USD)));
    c.env.fails_with(&ixs, &[&trader], "Slippage");
    // 10 SOL at 50× needs ~30 USDC of margin; 400 SOL needs ~1200 (fine), 2000 SOL needs ~6000 (too much)
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(2_000, 50, 152 * USD)));
    c.env.fails_with(&ixs, &[&trader], "InsufficientMargin");
}

#[test]
fn partial_then_full_liquidation() {
    let mut c = Core::new();
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 160 * USDC);
    let liq = c.env.funded();
    let (lm, _) = engine::trader(&mut c.env, &liq, 0);

    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);

    // healthy: not liquidatable
    let health = engine::health_metas(&m, &[(SOL, Side::Long)]);
    let i = engine::liquidate_ix(&liq.pubkey(), &lm, &trader.pubkey(), &m, SOL, Side::Long, health.clone());
    c.env.fails_with(&[i], &[&liq], "NotLiquidatable");

    // −9.7%: equity ≈ 9 < maintenance ≈ 13.5 but > half → 25% close
    c.env.advance(15);
    let mut ixs = c.quote(13_550 * USD / 100);
    ixs.push(engine::liquidate_ix(&liq.pubkey(), &lm, &trader.pubkey(), &m, SOL, Side::Long, health.clone()));
    c.env.ok(&ixs, &[&liq]);
    let pos: Position = c.env.account(&engine::position(&m, SOL, Side::Long));
    assert_eq!(pos.size, 75 * UNIT / 10);
    let bounty = c.margin(&lm).collateral;
    assert!(bounty > 0, "liquidator paid");

    // deeper: equity < 50% of maintenance → close the rest
    c.env.advance(15);
    let mut ixs = c.quote(134 * USD);
    ixs.push(engine::liquidate_ix(&liq.pubkey(), &lm, &trader.pubkey(), &m, SOL, Side::Long, health));
    c.env.ok(&ixs, &[&liq]);
    assert!(!c.env.exists(&engine::position(&m, SOL, Side::Long)));
    assert_eq!(c.margin(&m).open_positions, 0);
}

#[test]
fn withdraw_checks_health_and_is_never_paused() {
    let mut c = Core::new();
    let trader = c.env.funded();
    let (m, usdc) = engine::trader(&mut c.env, &trader, 1_000 * USDC);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 2, 151 * USD))); // IM ≈ 750
    c.env.ok(&ixs, &[&trader]);

    let g = c.env.guardian.insecure_clone();
    c.env.ok(&[engine::set_paused_ix(&g.pubkey(), true)], &[&g]);

    let health = engine::health_metas(&m, &[(SOL, Side::Long)]);
    c.env.fails_with(&[engine::withdraw_ix(&trader.pubkey(), &m, &usdc, 100 * USDC, vec![])], &[&trader], "HealthAccounts");
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::withdraw_ix(&trader.pubkey(), &m, &usdc, 400 * USDC, health.clone()));
    c.env.fails_with(&ixs, &[&trader], "InsufficientMargin");

    let before = c.env.token_balance(&usdc);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::withdraw_ix(&trader.pubkey(), &m, &usdc, 100 * USDC, health));
    c.env.ok(&ixs, &[&trader]);
    assert_eq!(c.env.token_balance(&usdc), before + 100 * USDC);
}

#[test]
fn merge_aggregates_shards_and_accrues_funding() {
    let mut c = Core::new();
    let mut margins = vec![];
    for _ in 0..4 {
        let t = c.env.funded();
        let (m, _) = engine::trader(&mut c.env, &t, 10_000 * USDC);
        let mut ixs = c.quote(150 * USD);
        ixs.push(engine::open_ix(&t.pubkey(), &m, SOL, long(100, 5, 152 * USD)));
        c.env.ok(&ixs, &[&t]);
        margins.push(m);
        c.env.advance(1);
    }
    c.post(150 * USD);
    let p = c.env.deployer.insecure_clone();
    c.env.ok(&[engine::merge_ix(SOL)], &[&p]);
    let fs: FundingState = c.env.account(&engine::funding(SOL));
    assert_eq!(fs.oi_long, 400 * UNIT);
    assert_eq!(fs.oi_short, 0);

    // a day later with long skew: rate rises and longs owe funding
    c.env.advance(86_400);
    // signer keys expire after 24h and must be rotated
    c.post_fails_expired();
    let (a, b) = (c.pusher_a.pubkey(), c.pusher_b.pubkey());
    oracle::register(&mut c.env, &a, source::CHAINLINK, SignerKind::Pusher);
    oracle::register(&mut c.env, &b, source::SWITCHBOARD, SignerKind::Pusher);
    c.post(150 * USD);
    c.env.ok(&[engine::merge_ix(SOL)], &[&p]);
    let fs: FundingState = c.env.account(&engine::funding(SOL));
    assert!(fs.rate > 0 && fs.index > 0 && fs.borrow_index > 0, "rate {} index {}", fs.rate, fs.index);
}

/// §12: every loosening action goes Squads → queue → 72h → execute.
#[test]
fn timelock_executes_only_after_72h() {
    let mut c = Core::with_engine_authority(Some(gov::executor()));
    let admin = c.env.funded();
    let g = c.env.guardian.insecure_clone();
    gov::initialize(&mut c.env, admin.pubkey(), g.pubkey());

    // the engine's authority is the executor PDA: queue "pause opens"
    let mut target = engine::set_paused_ix(&gov::executor(), true);
    target.accounts[0].is_signer = true;
    c.env.ok(&[gov::queue_ix(&admin.pubkey(), 0, &target)], &[&admin]);

    let p = c.env.deployer.insecure_clone();
    c.env.fails_with(&[gov::execute_ix(0, &target)], &[&p], "TooEarly");
    c.env.advance(72 * 3_600 - 10);
    c.env.fails_with(&[gov::execute_ix(0, &target)], &[&p], "TooEarly");
    c.env.advance(11);
    c.env.ok(&[gov::execute_ix(0, &target)], &[&p]);
    let cfg: lvrt_engine::EngineConfig = c.env.account(&engine::config());
    assert!(cfg.opens_paused);
    c.env.fails_with(&[gov::execute_ix(0, &target)], &[&p], "NotPending");

    // guardian can cancel a queued proposal
    let mut unpause = engine::set_paused_ix(&gov::executor(), false);
    unpause.accounts[0].is_signer = true;
    c.env.ok(&[gov::queue_ix(&admin.pubkey(), 1, &unpause)], &[&admin]);
    c.env.ok(&[gov::cancel_ix(&g.pubkey(), 1)], &[&g]);
    c.env.advance(72 * 3_600 + 1);
    c.env.fails_with(&[gov::execute_ix(1, &unpause)], &[&p], "NotPending");

    // nobody but the executor can act as the engine authority
    let a = c.env.authority.insecure_clone();
    c.env.fails_with(&[engine::set_paused_ix(&a.pubkey(), false)], &[&a], "NotAuthorityOrGuardian");
}
