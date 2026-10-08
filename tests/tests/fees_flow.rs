//! Fee router ledger CPIs: every token `distribute` moves is matched in the
//! receiving ledger — LP share raises the bucket's NAV, insurance share tops
//! up the fund, staker share becomes claimable rewards.

use lvrt_common::{lvrt_math::fees, Bucket, Side};
use lvrt_insurance::Fund;
use lvrt_tests::{
    engine,
    fixture::*,
    pool::{self, insurance, router, vault, Pool},
    *,
};
use lvrt_vault::BucketState;

const MAX_OI: u64 = 1_000_000 * USDC;
const LVRT: u64 = 1_000_000;

struct T {
    c: Core,
    pool: Pool,
}

impl T {
    fn new() -> Self {
        let mut c = Core::new();
        let pool = pool::setup(&mut c.env, Bucket::Core, MAX_OI);
        let lp = c.env.funded();
        pool::lp_deposit(&mut c.env, &pool, &lp, 1_000 * USDC);
        T { c, pool }
    }

    /// A 100 SOL round trip at an unchanged price, then settle: the shard's
    /// fees land in the bucket's inbox. Returns the inbox balance.
    fn fees_in_inbox(&mut self) -> u64 {
        let trader = self.c.env.funded();
        let (m, _) = engine::trader(&mut self.c.env, &trader, 10_000 * USDC);
        let mut ixs = self.c.quote(150 * USD);
        ixs.push(engine::open_ix(&trader.pubkey(), &m, SOL, long(100, 5, 151 * USD)));
        self.c.env.ok(&ixs, &[&trader]);
        self.c.env.advance(20);
        let mut ixs = self.c.quote(150 * USD);
        ixs.push(engine::close_ix(&trader.pubkey(), &trader.pubkey(), &m, SOL, Side::Long, 0, 149 * USD));
        self.c.env.ok(&ixs, &[&trader]);
        let p = self.c.env.deployer.insecure_clone();
        let k = engine::shard_of(&m, engine::SHARDS);
        self.c.env.ok(&[pool::settle_ix(&self.pool, SOL, k, engine::shard_of(&m, engine::CUSTODY_COUNT))], &[&p]);
        self.c.env.token_balance(&router::inbox(self.pool.bucket))
    }

    fn bucket(&self) -> BucketState {
        self.c.env.account(&vault::bucket(self.pool.bucket))
    }

    fn fund(&self) -> Fund {
        self.c.env.account(&insurance::fund(self.pool.bucket))
    }

    fn distribute(&mut self, operators: Option<Pubkey>) {
        let p = self.c.env.deployer.insecure_clone();
        self.c.env.ok(&[pool::distribute_with_operators_ix(&self.pool, operators)], &[&p]);
    }

    fn ledgers_match_tokens(&self) {
        let b = self.bucket();
        assert_eq!(b.usdc_balance, self.c.env.token_balance(&vault::usdc_vault(self.pool.bucket)), "vault ledger == tokens");
        let f = self.fund();
        assert_eq!(f.balance + f.rewards_unclaimed, self.c.env.token_balance(&insurance::usdc_vault(self.pool.bucket)), "fund ledger == tokens");
    }
}

#[test]
fn distribute_credits_the_vault_and_insurance_ledgers() {
    let mut t = T::new();
    let staker = t.c.env.funded();
    pool::stake(&mut t.c.env, &t.pool, &staker, 100 * LVRT);

    let total = t.fees_in_inbox();
    assert!(total > 10 * USDC, "fees {total}");
    let nav_before = t.bucket().nav();
    let cash_before = t.bucket().usdc_balance;
    // fund is below target → 20% insurance carve-out
    let split = fees::split_fee(total, 2_000).unwrap();

    t.distribute(None);

    let b = t.bucket();
    assert_eq!(b.usdc_balance, cash_before + split.lp);
    assert_eq!(b.nav(), nav_before + split.lp as i64, "LP fee share accrues to NAV");
    let f = t.fund();
    assert_eq!(f.balance, split.insurance);
    assert_eq!(f.rewards_unclaimed, split.stakers);
    assert_eq!(t.c.env.token_balance(&t.pool.treasury), split.treasury);
    assert_eq!(t.c.env.token_balance(&router::burn_vault()), split.burn);
    t.ledgers_match_tokens();

    // the staker can claim the 5% share
    let usdc = t.c.env.usdc_account(&staker.pubkey(), 0);
    t.c.env.ok(&[pool::claim_rewards_ix(&t.pool, &staker.pubkey(), &usdc)], &[&staker]);
    assert!(split.stakers - t.c.env.token_balance(&usdc) <= 1, "claimed {} of {}", t.c.env.token_balance(&usdc), split.stakers);
    t.ledgers_match_tokens();
}

#[test]
fn staker_share_joins_the_fund_when_nobody_stakes() {
    let mut t = T::new();
    let total = t.fees_in_inbox();
    let split = fees::split_fee(total, 2_000).unwrap();
    t.distribute(None);
    let f = t.fund();
    assert_eq!(f.balance, split.insurance + split.stakers);
    assert_eq!(f.rewards_unclaimed, 0);
    t.ledgers_match_tokens();
}

#[test]
fn operator_share_comes_out_of_the_lp_remainder() {
    let mut t = T::new();
    let a = t.c.env.authority.insecure_clone();
    let ops = t.c.env.usdc_account(&a.pubkey(), 0);

    // capped at 20% of fees, timelock only
    t.c.env.fails_with(&[pool::set_operators_ix(&a.pubkey(), &ops, 2_001)], &[&a], "OperatorShareTooHigh");
    let stranger = t.c.env.funded();
    t.c.env.fails_with(&[pool::set_operators_ix(&stranger.pubkey(), &ops, 1_000)], &[&stranger], "NotAuthority");
    t.c.env.ok(&[pool::set_operators_ix(&a.pubkey(), &ops, 1_000)], &[&a]);

    let total = t.fees_in_inbox();
    let split = fees::split_fee(total, 2_000).unwrap();
    let cash_before = t.bucket().usdc_balance;
    let p = t.c.env.deployer.insecure_clone();
    t.c.env.fails_with(&[pool::distribute_ix(&t.pool)], &[&p], "MissingOperators");
    t.distribute(Some(ops));

    let operators = total / 10;
    assert_eq!(t.c.env.token_balance(&ops), operators);
    assert_eq!(t.bucket().usdc_balance, cash_before + split.lp - operators);
    t.ledgers_match_tokens();
}

#[test]
fn only_the_fee_router_can_credit_ledgers() {
    let mut t = T::new();
    let stranger = t.c.env.funded();
    // tokens sent straight to the vaults don't become NAV or fund balance
    let i = ix(
        lvrt_vault::ID,
        lvrt_vault::instruction::CreditFees { amount: 1 },
        lvrt_vault::accounts::CreditFees {
            router_signer: stranger.pubkey(),
            config: vault::config(),
            bucket_state: vault::bucket(t.pool.bucket),
            usdc_vault: vault::usdc_vault(t.pool.bucket),
        },
        vec![],
    );
    t.c.env.fails_with(&[i], &[&stranger], "NotFeeRouter");
    let i = ix(
        lvrt_insurance::ID,
        lvrt_insurance::instruction::CreditFees { insurance: 1, stakers: 0 },
        lvrt_insurance::accounts::CreditFees {
            router_signer: stranger.pubkey(),
            config: insurance::config(),
            fund: insurance::fund(t.pool.bucket),
            usdc_vault: insurance::usdc_vault(t.pool.bucket),
        },
        vec![],
    );
    t.c.env.fails_with(&[i], &[&stranger], "NotFeeRouter");
}
