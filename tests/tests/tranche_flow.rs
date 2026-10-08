//! Staked $LVRT tranche (§5): slashed pro rata at the TWAP recovery price
//! before LLP NAV is touched, sold from escrow into the bucket, and stakers
//! can still unstake (post-slash) and claim rewards.

use lvrt_common::{lvrt_math::tranche, Bucket, Family, Side};
use lvrt_engine::MarketShard;
use lvrt_insurance::{Fund, InsuranceConfig, Stake};
use lvrt_oracle::FeedParams;
use lvrt_tests::{
    engine,
    fixture::*,
    oracle,
    pool::{self, insurance, vault, Pool, LVRT_DECIMALS, LVRT_MARKET},
    *,
};
use lvrt_vault::BucketState;

const MAX_OI: u64 = 1_000_000 * USDC;
const LVRT: u64 = 1_000_000; // 1 $LVRT
const TWO_USD: i64 = 2 * USD;
/// $2 TWAP less the 5% recovery discount.
const RECOVERY_PX: i64 = 190_000_000;

struct T {
    c: Core,
    pool: Pool,
}

impl T {
    fn new() -> Self {
        let mut c = Core::new();
        oracle::create_feed(
            &mut c.env,
            FeedParams {
                market_id: LVRT_MARKET,
                family: Family::Core,
                symbol: *b"LVRT\0\0\0\0\0\0\0\0\0\0\0\0",
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
        let pool = pool::setup(&mut c.env, Bucket::Core, MAX_OI);
        T { c, pool }
    }

    /// Post a fresh $LVRT price and fold it into the TWAP, in one transaction.
    fn twap_ixs(&self, px: i64) -> Vec<Instruction> {
        let ts = self.c.env.now() * 1_000 + 500;
        let mut v = oracle::post_ixs(
            LVRT_MARKET,
            &[
                (&self.c.pusher_a, price_msg(LVRT_MARKET, px, px / 1_000, ts, 0, false)),
                (&self.c.pusher_b, price_msg(LVRT_MARKET, px, px / 1_000, ts, 0, false)),
            ],
        );
        v.push(pool::update_twap_ix());
        v
    }

    fn update_twap(&mut self, px: i64) {
        let ixs = self.twap_ixs(px);
        let p = self.c.env.deployer.insecure_clone();
        self.c.env.ok(&ixs, &[&p]);
    }

    /// 10× long of 10 SOL on 160 USDC, gapped from 150 to 120 and liquidated
    /// in one go: ~142 USDC of bad debt in its shard.
    fn gap_liquidation(&mut self) -> (Pubkey, Pubkey, MarketShard) {
        let trader = self.c.env.funded();
        let (m, _) = engine::trader(&mut self.c.env, &trader, 160 * USDC);
        let liq = self.c.env.funded();
        let (lm, _) = engine::trader(&mut self.c.env, &liq, 0);
        let mut ixs = self.c.quote(150 * USD);
        ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(10, 10, 151 * USD)));
        self.c.env.ok(&ixs, &[&trader]);
        self.c.env.advance(15);
        let mut ixs = self.c.quote(120 * USD);
        let health = engine::health_metas(&m, &[(SOL, Side::Long)]);
        ixs.push(engine::liquidate_ix(&liq.pubkey(), &lm, &trader.pubkey(), &m, SOL, Side::Long, health));
        self.c.env.ok(&ixs, &[&liq]);
        let s: MarketShard = self.c.env.account(&engine::shard(SOL, engine::shard_of(&m, engine::SHARDS)));
        assert!(s.bad_debt > 100 * USDC, "scenario: large bad debt, got {}", s.bad_debt);
        (m, lm, s)
    }

    fn settle_ix(&self, m: &Pubkey) -> Instruction {
        pool::settle_ix(&self.pool, SOL, engine::shard_of(m, engine::SHARDS), engine::shard_of(m, engine::CUSTODY_COUNT))
    }

    fn fund(&self) -> Fund {
        self.c.env.account(&insurance::fund(self.pool.bucket))
    }

    fn bucket(&self) -> BucketState {
        self.c.env.account(&vault::bucket(self.pool.bucket))
    }

    fn stake_of(&self, owner: &Pubkey) -> Stake {
        self.c.env.account(&insurance::stake(&insurance::fund(self.pool.bucket), owner))
    }

    fn backing(&self, owner: &Pubkey) -> u64 {
        let f = self.fund();
        tranche::lvrt_for_shares(self.stake_of(owner).shares, f.total_shares, f.total_staked).unwrap()
    }
}

#[test]
fn bad_debt_slashes_the_tranche_pro_rata_before_nav() {
    let mut t = T::new();
    let (s1, s2) = (t.c.env.funded(), t.c.env.funded());
    pool::stake(&mut t.c.env, &t.pool, &s1, 100 * LVRT);
    pool::stake(&mut t.c.env, &t.pool, &s2, 300 * LVRT);
    t.update_twap(TWO_USD);
    let cfg: InsuranceConfig = t.c.env.account(&insurance::config());
    assert_eq!(cfg.twap, TWO_USD);

    let (m, lm, s) = t.gap_liquidation();
    let p = t.c.env.deployer.insecure_clone();
    t.c.env.ok(&[t.settle_ix(&m)], &[&p]);

    // the tranche covered all of it at $1.90 per $LVRT
    let slashed = tranche::lvrt_for_usdc(s.bad_debt, RECOVERY_PX, LVRT_DECIMALS).unwrap();
    let f = t.fund();
    assert_eq!(f.escrow_lvrt, slashed);
    assert_eq!(f.total_staked, 400 * LVRT - slashed);
    assert_eq!(f.recovery_owed, s.bad_debt);
    assert_eq!(t.c.env.token_balance(&insurance::slash_escrow(t.pool.bucket)), slashed);

    // pro rata: 25% / 75% of the slash
    assert_eq!(t.backing(&s1.pubkey()), (400 * LVRT - slashed) / 4);
    assert!(t.backing(&s2.pubkey()).abs_diff((400 * LVRT - slashed) * 3 / 4) <= 1);

    // NAV untouched: cash + receivable == the trader's full loss
    let b = t.bucket();
    assert_eq!(b.slash_receivable, s.bad_debt);
    assert_eq!(b.usdc_balance + b.slash_receivable, (-s.trader_pnl_unsettled + s.carry_unsettled) as u64);
    assert_eq!(b.usdc_balance, t.c.env.token_balance(&vault::usdc_vault(t.pool.bucket)));
    let owed: u64 = [m, lm].iter().map(|k| t.c.margin(k).collateral as u64).sum();
    assert_eq!(pool::custody_total(&t.c.env), owed);
}

#[test]
fn escrowed_lvrt_sells_into_the_bucket() {
    let mut t = T::new();
    let s1 = t.c.env.funded();
    pool::stake(&mut t.c.env, &t.pool, &s1, 400 * LVRT);
    t.update_twap(TWO_USD);
    let (m, _, s) = t.gap_liquidation();
    let p = t.c.env.deployer.insecure_clone();
    t.c.env.ok(&[t.settle_ix(&m)], &[&p]);
    let escrow = t.fund().escrow_lvrt;
    let cash_before = t.bucket().usdc_balance;

    let buyer = t.c.env.funded();
    let buyer_usdc = t.c.env.usdc_account(&buyer.pubkey(), 10_000 * USDC);
    let buyer_lvrt = t.c.env.token_account(&t.pool.lvrt_mint, &buyer.pubkey(), &SPL_TOKEN);

    // half first, slippage-protected
    let half = escrow / 2;
    let cost = tranche::value_usdc_up(half, RECOVERY_PX, LVRT_DECIMALS).unwrap();
    t.c.env.fails_with(&[pool::buy_slashed_ix(&t.pool, &buyer.pubkey(), &buyer_lvrt, &buyer_usdc, half, cost - 1)], &[&buyer], "Slippage");
    t.c.env.ok(&[pool::buy_slashed_ix(&t.pool, &buyer.pubkey(), &buyer_lvrt, &buyer_usdc, half, cost)], &[&buyer]);
    assert_eq!(t.c.env.token_balance(&buyer_lvrt), half);
    let b = t.bucket();
    assert_eq!(b.usdc_balance, cash_before + cost);
    assert_eq!(b.slash_receivable, s.bad_debt - (s.bad_debt as u128 * half as u128 / escrow as u128) as u64);

    // the rest settles the receivable to zero
    let rest = escrow - half;
    t.c.env.ok(&[pool::buy_slashed_ix(&t.pool, &buyer.pubkey(), &buyer_lvrt, &buyer_usdc, rest, 1_000 * USDC)], &[&buyer]);
    let (b, f) = (t.bucket(), t.fund());
    assert_eq!((b.slash_receivable, f.escrow_lvrt, f.recovery_owed), (0, 0, 0));
    assert!(b.usdc_balance >= cash_before + s.bad_debt, "sold at the booked price: bucket made whole");
    assert_eq!(b.usdc_balance, t.c.env.token_balance(&vault::usdc_vault(t.pool.bucket)));
}

#[test]
fn slashing_needs_a_fresh_twap() {
    let mut t = T::new();
    let s1 = t.c.env.funded();
    pool::stake(&mut t.c.env, &t.pool, &s1, 400 * LVRT);
    t.update_twap(TWO_USD);
    t.c.env.advance(2 * 3_600);
    let (m, _, _) = t.gap_liquidation();
    let p = t.c.env.deployer.insecure_clone();
    t.c.env.fails_with(&[t.settle_ix(&m)], &[&p], "StaleTwap");
    // a cranker refreshes the TWAP in the same transaction
    let mut ixs = t.twap_ixs(TWO_USD);
    ixs.push(t.settle_ix(&m));
    t.c.env.ok(&ixs, &[&p]);
    assert!(t.fund().escrow_lvrt > 0);
}

#[test]
fn a_tranche_smaller_than_the_loss_is_wiped_and_the_rest_hits_nav() {
    let mut t = T::new();
    let s1 = t.c.env.funded();
    let lvrt_acc = pool::stake(&mut t.c.env, &t.pool, &s1, 10 * LVRT); // worth $19 at recovery
    t.update_twap(TWO_USD);
    let (m, _, s) = t.gap_liquidation();
    let p = t.c.env.deployer.insecure_clone();
    t.c.env.ok(&[t.settle_ix(&m)], &[&p]);

    let f = t.fund();
    assert_eq!((f.total_staked, f.total_shares, f.share_epoch), (0, 0, 1));
    assert_eq!(f.recovery_owed, 19 * USDC);
    let b = t.bucket();
    assert_eq!(b.slash_receivable, 19 * USDC);
    // NAV absorbs only what the tranche couldn't
    let full_loss = (-s.trader_pnl_unsettled + s.carry_unsettled) as u64;
    assert_eq!(b.usdc_balance + b.slash_receivable, full_loss - (s.bad_debt - 19 * USDC));

    // the wiped staker's shares are gone; a new staker starts 1:1
    t.c.env.fails_with(&[pool::request_unstake_ix(&t.pool, &s1.pubkey(), 1)], &[&s1], "InsufficientStake");
    let _ = lvrt_acc;
    let s2 = t.c.env.funded();
    pool::stake(&mut t.c.env, &t.pool, &s2, 50 * LVRT);
    assert_eq!(t.stake_of(&s2.pubkey()).shares, 50 * LVRT);
    assert_eq!(t.backing(&s2.pubkey()), 50 * LVRT);
}

#[test]
fn unstake_after_cooldown_pays_the_post_slash_amount_and_rewards_are_claimable() {
    let mut t = T::new();
    let (s1, s2) = (t.c.env.funded(), t.c.env.funded());
    let lvrt1 = pool::stake(&mut t.c.env, &t.pool, &s1, 100 * LVRT);
    pool::stake(&mut t.c.env, &t.pool, &s2, 300 * LVRT);

    // 5% staker share of fees, per share
    pool::add_staker_rewards(&mut t.c.env, &t.pool, 40 * USDC);
    let usdc1 = t.c.env.usdc_account(&s1.pubkey(), 0);
    t.c.env.ok(&[pool::claim_rewards_ix(&t.pool, &s1.pubkey(), &usdc1)], &[&s1]);
    assert_eq!(t.c.env.token_balance(&usdc1), 10 * USDC);
    t.c.env.fails_with(&[pool::claim_rewards_ix(&t.pool, &s1.pubkey(), &usdc1)], &[&s1], "Noop");

    // s1 asks to leave; a slash during the cooldown still hits those shares
    let shares = t.stake_of(&s1.pubkey()).shares;
    t.c.env.ok(&[pool::request_unstake_ix(&t.pool, &s1.pubkey(), shares)], &[&s1]);
    t.c.env.fails_with(&[pool::unstake_ix(&t.pool, &s1.pubkey(), &lvrt1)], &[&s1], "Cooldown");
    t.update_twap(TWO_USD);
    let (m, _, _) = t.gap_liquidation();
    let p = t.c.env.deployer.insecure_clone();
    t.c.env.ok(&[t.settle_ix(&m)], &[&p]);
    let owed = t.backing(&s1.pubkey());
    assert!(owed < 100 * LVRT);

    t.c.env.advance(14 * 86_400);
    t.c.env.ok(&[pool::unstake_ix(&t.pool, &s1.pubkey(), &lvrt1)], &[&s1]);
    assert_eq!(t.c.env.token_balance(&lvrt1), owed);
    assert_eq!(t.stake_of(&s1.pubkey()).shares, 0);
    // s2 is untouched by s1 leaving
    let f = t.fund();
    assert_eq!(f.total_shares, t.stake_of(&s2.pubkey()).shares);
}
