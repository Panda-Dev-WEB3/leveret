//! ADL (§3.5): only when trader uPnL ≥ 95% of the bucket's capital, top rank
//! first, just enough to get back to 90%, at the mark — and the bucket can
//! still pay every winner afterwards.

use lvrt_common::{Bucket, Side};
use lvrt_engine::{BucketRisk, FundingState, MarginAccount, MarketShard, OpenArgs, Position};
use lvrt_tests::{
    engine,
    fixture::*,
    pool::{self, vault, Pool},
    *,
};

const MAX_OI: u64 = 1_000_000 * USDC;
const BUCKET: Bucket = Bucket::Core;

struct Adl {
    c: Core,
    pool: Pool,
    operator: Keypair,
}

impl Adl {
    /// LP capital `lp` USDC; ADL armed at 95% → 90%.
    fn new(lp: u64) -> Self {
        let mut c = Core::new();
        let pool = pool::setup(&mut c.env, BUCKET, MAX_OI);
        let lp_key = c.env.funded();
        pool::lp_deposit(&mut c.env, &pool, &lp_key, lp * USDC);
        let operator = c.env.funded();
        let a = c.env.authority.insecure_clone();
        c.env.ok(&[engine::set_adl_params_ix(&a.pubkey(), &operator.pubkey(), 9_500, 9_000)], &[&a]);
        Adl { c, pool, operator }
    }

    fn trader(&mut self, deposit: u64, args: OpenArgs) -> (Keypair, Pubkey) {
        let t = self.c.env.funded();
        let (m, _) = engine::trader(&mut self.c.env, &t, deposit * USDC);
        let mut ixs = self.c.quote(150 * USD);
        ixs.push(engine::open_ix(&t.pubkey(), &m, SOL, args));
        self.c.env.ok(&ixs, &[&t]);
        (t, m)
    }

    /// Fresh price + merge, so the bucket view is current.
    fn mark(&mut self, px: i64) {
        self.c.env.advance(20);
        self.c.post(px);
        let p = self.c.env.deployer.insecure_clone();
        self.c.env.ok(&[engine::merge_ix(SOL)], &[&p]);
    }

    fn adl(&self, owner: &Keypair, m: &Pubkey, side: Side) -> Instruction {
        engine::adl_ix(&self.operator.pubkey(), &owner.pubkey(), m, SOL, side, BUCKET, &[SOL])
    }

    fn run(&mut self, ix: Instruction) {
        let op = self.operator.insecure_clone();
        self.c.env.ok(&[ix], &[&op]);
    }

    fn run_fails(&mut self, ix: Instruction, needle: &str) {
        let op = self.operator.insecure_clone();
        self.c.env.fails_with(&[ix], &[&op], needle);
    }

    fn size(&self, m: &Pubkey, side: Side) -> u64 {
        let p = engine::position(m, SOL, side);
        if self.c.env.exists(&p) {
            self.c.env.account::<Position>(&p).size
        } else {
            0
        }
    }
}

fn short(units: u64, lev: u32) -> OpenArgs {
    OpenArgs { side: Side::Short, size: units * UNIT, price_bound: 149 * USD, leverage_x100: lev * 100, isolated_margin: 0 }
}

#[test]
fn adl_is_refused_while_the_bucket_is_healthy() {
    let mut t = Adl::new(1_000);
    let (a, ma) = t.trader(1_000, long(10, 10, 151 * USD));
    t.mark(160 * USD); // uPnL ≈ 99 vs 1000 of capital
    t.run_fails(t.adl(&a, &ma, Side::Long), "AdlNotTriggered");
}

#[test]
fn adl_closes_top_rank_first_and_stops_at_target() {
    let mut t = Adl::new(1_000);
    let (a, ma) = t.trader(1_000, long(10, 10, 151 * USD)); // margin ≈ 150 → high rank
    let (b, mb) = t.trader(5_000, long(10, 2, 151 * USD)); // margin ≈ 750
    t.mark(200 * USD); // each +499.25: 998.5 of 1000 → 99.85%

    // A: closing all of it still leaves the ratio above target
    let shard_a = engine::shard(SOL, engine::shard_of(&ma, engine::SHARDS));
    let carry_before = t.c.env.account::<MarketShard>(&shard_a).carry_unsettled;
    let before = t.c.margin(&ma).collateral;
    t.run(t.adl(&a, &ma, Side::Long));
    assert_eq!(t.size(&ma, Side::Long), 0);
    let carry = t.c.env.account::<MarketShard>(&shard_a).carry_unsettled - carry_before;
    let acc: MarginAccount = t.c.env.account(&ma);
    // closed at the exact mark with no fee: +10 × (200 − 150.075), less the
    // funding/borrow accrued since open
    assert!(carry > 0);
    assert_eq!(acc.collateral - before, 499_250_000 - carry);
    let br: BucketRisk = t.c.env.account(&engine::bucket_risk(BUCKET));
    assert!(br.adl_active && br.adl_round == 1);

    // B (lower rank): only ~97% of it is needed to get back to 90%
    t.run(t.adl(&b, &mb, Side::Long));
    let left = t.size(&mb, Side::Long);
    assert!(left > 0 && left < UNIT, "partial close, left {left}");
    let br: BucketRisk = t.c.env.account(&engine::bucket_risk(BUCKET));
    assert!(!br.adl_active, "round ends at the target");

    // the bucket can now pay both winners: settle every touched shard
    let p = t.c.env.deployer.insecure_clone();
    t.c.env.advance(1);
    t.c.post(200 * USD);
    t.c.env.ok(&[engine::merge_ix(SOL)], &[&p]);
    let mut shards: Vec<u8> = [ma, mb].iter().map(|m| engine::shard_of(m, engine::SHARDS)).collect();
    shards.dedup();
    for k in shards {
        t.c.env.ok(&[pool::settle_ix(&t.pool, SOL, k, engine::shard_of(&mb, engine::CUSTODY_COUNT))], &[&p]);
    }
    let fs: FundingState = t.c.env.account(&engine::funding(SOL));
    assert_eq!(fs.unsettled_to_bucket, 0, "merged view cleared by settlement");
    let owed: u64 = [ma, mb].iter().map(|m| t.c.margin(m).collateral as u64).sum();
    assert_eq!(pool::custody_total(&t.c.env), owed, "custody == Σ trader ledgers");
    assert!(t.c.env.token_balance(&vault::usdc_vault(BUCKET)) > 0, "bucket stayed solvent");
}

#[test]
fn ranks_within_a_round_must_not_increase() {
    let mut t = Adl::new(1_000);
    let (a, ma) = t.trader(1_000, long(10, 10, 151 * USD));
    let (b, mb) = t.trader(5_000, long(10, 2, 151 * USD));
    t.mark(200 * USD);
    // the operator goes for the lower-ranked B first…
    t.run(t.adl(&b, &mb, Side::Long));
    // …and can't come back up to A in the same round
    t.run_fails(t.adl(&a, &ma, Side::Long), "AdlRankOrder");
    let _ = a;
}

#[test]
fn adl_guards() {
    let mut t = Adl::new(400);
    let (a, ma) = t.trader(1_000, long(10, 10, 151 * USD));
    let (c, mc) = t.trader(1_000, short(2, 10));
    t.mark(200 * USD); // longs +499, short −100 → 399 of 400

    // only the operator
    let stranger = t.c.env.funded();
    let i = engine::adl_ix(&stranger.pubkey(), &a.pubkey(), &ma, SOL, Side::Long, BUCKET, &[SOL]);
    t.c.env.fails_with(&[i], &[&stranger], "NotAdlOperator");
    // every market of the bucket must be supplied
    t.run_fails(engine::adl_ix(&t.operator.pubkey(), &a.pubkey(), &ma, SOL, Side::Long, BUCKET, &[]), "AdlAccounts");
    // never a losing position
    t.run_fails(t.adl(&c, &mc, Side::Short), "AdlNotProfitable");

    // a stale merge doesn't count
    for _ in 0..30 {
        t.c.env.advance(1);
    }
    t.c.post(200 * USD);
    t.run_fails(t.adl(&a, &ma, Side::Long), "StaleMerge");
}
