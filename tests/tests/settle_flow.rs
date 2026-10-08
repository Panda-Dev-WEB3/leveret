//! `settle_shard`: fees to the fee router, net trader PnL + carry between
//! custody and the LLP bucket, bad debt through insurance — and afterwards
//! custody holds exactly what trader ledgers say it should.

use lvrt_common::{Bucket, Side};
use lvrt_engine::{MarketShard, Position};
use lvrt_insurance::Fund;
use lvrt_tests::{
    engine,
    fixture::*,
    pool::{self, insurance, router, vault, Pool},
    *,
};
use lvrt_vault::BucketState;

const MAX_OI: u64 = 1_000_000 * USDC;

fn shard_state(c: &Core, m: &Pubkey) -> (u8, MarketShard) {
    let k = engine::shard_of(m, engine::SHARDS);
    (k, c.env.account(&engine::shard(SOL, k)))
}

fn custody_ix(m: &Pubkey) -> u8 {
    engine::shard_of(m, engine::CUSTODY_COUNT)
}

/// Σ collateral + queued profit of the given margin accounts.
fn owed(c: &Core, margins: &[Pubkey]) -> u64 {
    margins
        .iter()
        .map(|m| {
            let a = c.margin(m);
            a.collateral as u64 + a.queued_profit
        })
        .sum()
}

fn bucket_matches_vault(c: &Core, pool: &Pool) {
    let b: BucketState = c.env.account(&vault::bucket(pool.bucket));
    assert_eq!(b.usdc_balance, c.env.token_balance(&vault::usdc_vault(pool.bucket)), "vault ledger == tokens");
}

#[test]
fn losing_trader_pays_bucket_carry_and_fees() {
    let mut c = Core::new();
    let pool = pool::setup(&mut c.env, Bucket::Core, MAX_OI);
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 5_000 * USDC);
    let p = c.env.deployer.insecure_clone();

    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);
    c.env.ok(&[engine::merge_ix(SOL)], &[&p]);

    // an hour of long skew: funding + borrow accrue on the position
    c.env.advance(3_600);
    c.post(150 * USD);
    c.env.ok(&[engine::merge_ix(SOL)], &[&p]);

    c.env.advance(20);
    let mut ixs = c.quote(140 * USD);
    ixs.push(engine::close_ix(&trader.pubkey(), &trader.pubkey(), &m, SOL, Side::Long, 0, 139 * USD));
    c.env.ok(&ixs, &[&trader]);

    let (k, s) = shard_state(&c, &m);
    assert!(s.trader_pnl_unsettled < 0, "trader lost");
    assert!(s.carry_unsettled > 0, "carry was charged: {}", s.carry_unsettled);
    assert_eq!(s.bad_debt, 0);
    let expect_bucket = (-s.trader_pnl_unsettled + s.carry_unsettled) as u64;

    c.env.ok(&[pool::settle_ix(&pool, SOL, k, custody_ix(&m))], &[&p]);

    assert_eq!(c.env.token_balance(&router::inbox(pool.bucket)), s.fees_accrued);
    assert_eq!(c.env.token_balance(&vault::usdc_vault(pool.bucket)), expect_bucket);
    bucket_matches_vault(&c, &pool);
    assert_eq!(pool::custody_total(&c.env), owed(&c, &[m]), "custody == Σ trader ledgers");
    let (_, s) = shard_state(&c, &m);
    assert_eq!((s.fees_accrued, s.trader_pnl_unsettled, s.carry_unsettled, s.bad_debt), (0, 0, 0, 0));

    // nothing left to settle
    c.env.fails_with(&[pool::settle_ix(&pool, SOL, k, custody_ix(&m))], &[&p], "Noop");

    // the fee router then splits the inbox: 10% treasury
    let fees = c.env.token_balance(&router::inbox(pool.bucket));
    c.env.ok(&[pool::distribute_ix(&pool)], &[&p]);
    assert_eq!(c.env.token_balance(&router::inbox(pool.bucket)), 0);
    assert_eq!(c.env.token_balance(&pool.treasury), fees / 10);
}

#[test]
fn winning_trader_is_paid_by_bucket_and_can_withdraw_everything() {
    let mut c = Core::new();
    let pool = pool::setup(&mut c.env, Bucket::Core, MAX_OI);
    let lp = c.env.funded();
    pool::lp_deposit(&mut c.env, &pool, &lp, 10_000 * USDC);

    let trader = c.env.funded();
    let (m, usdc) = engine::trader(&mut c.env, &trader, 5_000 * USDC);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);
    c.env.advance(20);
    let mut ixs = c.quote(160 * USD);
    ixs.push(engine::close_ix(&trader.pubkey(), &trader.pubkey(), &m, SOL, Side::Long, 0, 159 * USD));
    c.env.ok(&ixs, &[&trader]);

    // before settlement the ledger owes more than custody holds
    let collateral = c.margin(&m).collateral as u64;
    assert!(collateral > 5_000 * USDC && pool::custody_total(&c.env) < collateral);

    let (k, s) = shard_state(&c, &m);
    let p = c.env.deployer.insecure_clone();
    c.env.ok(&[pool::settle_ix(&pool, SOL, k, custody_ix(&m))], &[&p]);

    assert_eq!(c.env.token_balance(&vault::usdc_vault(pool.bucket)), 10_000 * USDC - s.trader_pnl_unsettled as u64);
    bucket_matches_vault(&c, &pool);
    assert_eq!(pool::custody_total(&c.env), collateral);

    // the full balance, profit included, can now leave custody
    let before = c.env.token_balance(&usdc);
    c.env.ok(&[engine::withdraw_ix(&trader.pubkey(), &m, &usdc, collateral, vec![])], &[&trader]);
    assert_eq!(c.env.token_balance(&usdc), before + collateral);
    assert_eq!(pool::custody_total(&c.env), 0);
}

/// Opens 10× long with 160 USDC and drives it through a partial and a full
/// liquidation that ends in bad debt.
fn bad_debt_scenario(c: &mut Core) -> (Pubkey, Pubkey) {
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 160 * USDC);
    let liq = c.env.funded();
    let (lm, _) = engine::trader(&mut c.env, &liq, 0);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);
    let health = engine::health_metas(&m, &[(SOL, Side::Long)]);
    for px in [13_550 * USD / 100, 134 * USD] {
        c.env.advance(15);
        let mut ixs = c.quote(px);
        ixs.push(engine::liquidate_ix(&liq.pubkey(), &lm, &trader.pubkey(), &m, SOL, Side::Long, health.clone()));
        c.env.ok(&ixs, &[&liq]);
    }
    assert!(!c.env.exists(&engine::position(&m, SOL, Side::Long)));
    (m, lm)
}

#[test]
fn bad_debt_is_covered_by_the_insurance_fund() {
    let mut c = Core::new();
    let pool = pool::setup(&mut c.env, Bucket::Core, MAX_OI);
    pool::fund_insurance(&mut c.env, &pool, 100 * USDC);
    let (m, lm) = bad_debt_scenario(&mut c);

    let (k, s) = shard_state(&c, &m);
    assert!(s.bad_debt > 0, "scenario produces bad debt");
    let p = c.env.deployer.insecure_clone();
    c.env.ok(&[pool::settle_ix(&pool, SOL, k, custody_ix(&m))], &[&p]);

    // insurance made the bucket whole: it holds the trader's full loss
    let fund: Fund = c.env.account(&insurance::fund(pool.bucket));
    assert_eq!(fund.balance, 100 * USDC - s.bad_debt);
    assert_eq!(c.env.token_balance(&insurance::usdc_vault(pool.bucket)), 100 * USDC - s.bad_debt);
    assert_eq!(c.env.token_balance(&vault::usdc_vault(pool.bucket)), (-s.trader_pnl_unsettled + s.carry_unsettled) as u64);
    bucket_matches_vault(&c, &pool);
    // what's left in custody is exactly the liquidator's bounty
    assert_eq!(c.margin(&m).collateral, 0);
    assert_eq!(pool::custody_total(&c.env), owed(&c, &[m, lm]));
}

#[test]
fn uncovered_bad_debt_falls_on_the_bucket() {
    let mut c = Core::new();
    let pool = pool::setup(&mut c.env, Bucket::Core, MAX_OI);
    let (m, lm) = bad_debt_scenario(&mut c); // insurance fund is empty

    let (k, s) = shard_state(&c, &m);
    let p = c.env.deployer.insecure_clone();
    c.env.ok(&[pool::settle_ix(&pool, SOL, k, custody_ix(&m))], &[&p]);

    let expect = (-s.trader_pnl_unsettled + s.carry_unsettled) as u64 - s.bad_debt;
    assert_eq!(c.env.token_balance(&vault::usdc_vault(pool.bucket)), expect);
    bucket_matches_vault(&c, &pool);
    assert_eq!(pool::custody_total(&c.env), owed(&c, &[m, lm]));
}

#[test]
fn settlement_rejects_a_custody_that_cannot_cover_it() {
    let mut c = Core::new();
    let pool = pool::setup(&mut c.env, Bucket::Core, MAX_OI);
    let trader = c.env.funded();
    let (m, _) = engine::trader(&mut c.env, &trader, 5_000 * USDC);
    let mut ixs = c.quote(150 * USD);
    ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
    c.env.ok(&ixs, &[&trader]);
    let pos: Position = c.env.account(&engine::position(&m, SOL, Side::Long));
    assert_eq!(pos.size, 10 * UNIT);

    // the other custody shard is empty
    let (k, _) = shard_state(&c, &m);
    let empty = 1 - custody_ix(&m);
    let p = c.env.deployer.insecure_clone();
    c.env.fails_with(&[pool::settle_ix(&pool, SOL, k, empty)], &[&p], "InsufficientCustody");
    c.env.ok(&[pool::settle_ix(&pool, SOL, k, custody_ix(&m))], &[&p]);
    assert_eq!(c.env.token_balance(&router::inbox(pool.bucket)), 900_450);
}
