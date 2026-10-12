//! Limit-open orders: margin reserved at placement, filled by a keeper
//! through the open fill path only once the price is through the limit,
//! reserve returned on cancel / expiry.

use lvrt_common::{seeds, Side};
use lvrt_engine::{accounts as acc, instruction as ins, LimitArgs, LimitOrder, MarginAccount, Position};
use lvrt_tests::{engine, fixture::*, oracle, *};

fn order(m: &Pubkey, nonce: u64) -> Pubkey {
    pda(&[seeds::LIMIT, m.as_ref(), &nonce.to_le_bytes()], &lvrt_engine::ID)
}

fn place_ix(signer: &Pubkey, m: &Pubkey, nonce: u64, args: LimitArgs) -> Instruction {
    ix(
        lvrt_engine::ID,
        ins::PlaceLimit { nonce, args },
        acc::PlaceLimit { signer: *signer, margin: *m, market: engine::market(SOL), order: order(m, nonce), system_program: SYSTEM },
        vec![],
    )
}

fn cancel_ix(signer: &Pubkey, m: &Pubkey, owner: &Pubkey, nonce: u64) -> Instruction {
    ix(lvrt_engine::ID, ins::CancelLimit {}, acc::CancelLimit { signer: *signer, margin: *m, order: order(m, nonce), owner: *owner }, vec![])
}

fn execute_ix(keeper: &Pubkey, keeper_margin: &Pubkey, m: &Pubkey, nonce: u64, side: Side) -> Instruction {
    ix(
        lvrt_engine::ID,
        ins::ExecuteLimit {},
        acc::ExecuteLimit {
            keeper: *keeper,
            keeper_margin: *keeper_margin,
            order: order(m, nonce),
            config: engine::config(),
            margin: *m,
            market: engine::market(SOL),
            funding_state: engine::funding(SOL),
            price_state: oracle::price(SOL),
            shard: engine::shard(SOL, engine::shard_of(m, engine::SHARDS)),
            position: engine::position(m, SOL, side),
            system_program: SYSTEM,
        },
        vec![],
    )
}

fn args(side: Side, limit: i64, expiry: i64) -> LimitArgs {
    LimitArgs { side, size: 10 * UNIT, limit_px: limit, leverage_x100: 500, isolated_margin: 0, expiry, keeper_bounty: USDC / 10 }
}

struct T {
    c: Core,
    owner: Keypair,
    m: Pubkey,
    usdc: Pubkey,
    keeper: Keypair,
    km: Pubkey,
}

impl T {
    fn new() -> Self {
        let mut c = Core::new();
        c.post(150 * USD);
        let owner = c.env.funded();
        let (m, usdc) = engine::trader(&mut c.env, &owner, 1_000 * USDC);
        let keeper = c.env.funded();
        let (km, _) = engine::trader(&mut c.env, &keeper, 0);
        T { c, owner, m, usdc, keeper, km }
    }

    fn execute_at(&mut self, mid: i64, nonce: u64, side: Side) -> TxResult {
        self.c.env.advance(1);
        let mut v = self.c.quote(mid);
        v.push(execute_ix(&self.keeper.pubkey(), &self.km, &self.m, nonce, side));
        let k = self.keeper.insecure_clone();
        self.c.env.send(&v, &[&k])
    }
}

#[test]
fn a_buy_limit_reserves_margin_and_fills_only_through_the_limit() {
    let mut t = T::new();
    let o = t.owner.insecure_clone();
    let expiry = t.c.env.now() + 3_600;
    t.c.env.ok(&[place_ix(&o.pubkey(), &t.m, 1, args(Side::Long, 145 * USD, expiry))], &[&o]);
    let lo: LimitOrder = t.c.env.account(&order(&t.m, 1));
    // IM at 5× of 10 × 145 = 290, plus the max fee and the bounty
    assert!(lo.reserved > 290 * USDC && lo.reserved < 292 * USDC, "reserved {}", lo.reserved);
    let mm: MarginAccount = t.c.env.account(&t.m);
    assert_eq!(mm.collateral as u64, 1_000 * USDC - lo.reserved);

    // the reserve can't be withdrawn
    let w = engine::withdraw_ix(&o.pubkey(), &t.m, &t.usdc, 1_000 * USDC - lo.reserved + 1, vec![]);
    t.c.env.fails_with(&[w], &[&o], "InsufficientMargin");

    // at 150 the fill would be above the limit: not executable
    let e = t.execute_at(150 * USD, 1, Side::Long).expect_err("must not fill above the limit");
    assert!(e.1.join("\n").contains("Slippage"), "{e:?}");

    // the price drops through the limit: a keeper fills it
    let keeper_lamports = t.c.env.svm.get_balance(&t.keeper.pubkey()).unwrap();
    t.execute_at(144 * USD, 1, Side::Long).expect("fills through the limit");
    let p: Position = t.c.env.account(&engine::position(&t.m, SOL, Side::Long));
    assert_eq!(p.size, 10 * UNIT);
    assert!(p.entry_px <= 145 * USD, "entry {} above the limit", p.entry_px);
    assert!(!t.c.env.exists(&order(&t.m, 1)));
    let km: MarginAccount = t.c.env.account(&t.km);
    assert_eq!(km.collateral as u64, USDC / 10, "bounty to the keeper");
    // the order's rent went to the keeper and nearly covers the position rent it
    // paid; what's left is two transaction fees and the size difference
    let after = t.c.env.svm.get_balance(&t.keeper.pubkey()).unwrap();
    assert!(after + 50_000 >= keeper_lamports, "keeper lost {} lamports", keeper_lamports - after);
    let mm: MarginAccount = t.c.env.account(&t.m);
    assert!(mm.collateral > 995 * USDC as i64, "only the fee and the bounty were spent: {}", mm.collateral);
    assert_eq!(mm.open_positions, 1);
}

#[test]
fn a_sell_limit_fills_only_at_or_above_its_price() {
    let mut t = T::new();
    let o = t.owner.insecure_clone();
    let expiry = t.c.env.now() + 3_600;
    t.c.env.ok(&[place_ix(&o.pubkey(), &t.m, 7, args(Side::Short, 155 * USD, expiry))], &[&o]);
    assert!(t.execute_at(152 * USD, 7, Side::Short).is_err());
    t.execute_at(156 * USD, 7, Side::Short).expect("fills through the limit");
    let p: Position = t.c.env.account(&engine::position(&t.m, SOL, Side::Short));
    assert!(p.entry_px >= 155 * USD);
}

#[test]
fn cancel_returns_the_reserve_and_expiry_frees_it_for_anyone() {
    let mut t = T::new();
    let o = t.owner.insecure_clone();
    let expiry = t.c.env.now() + 600;
    t.c.env.ok(&[place_ix(&o.pubkey(), &t.m, 1, args(Side::Long, 140 * USD, expiry))], &[&o]);
    t.c.env.ok(&[place_ix(&o.pubkey(), &t.m, 2, args(Side::Long, 139 * USD, expiry))], &[&o]);

    // the owner cancels one
    t.c.env.ok(&[cancel_ix(&o.pubkey(), &t.m, &o.pubkey(), 1)], &[&o]);
    let lo2: LimitOrder = t.c.env.account(&order(&t.m, 2));
    let mm: MarginAccount = t.c.env.account(&t.m);
    assert_eq!(mm.collateral as u64, 1_000 * USDC - lo2.reserved);

    // a stranger can't cancel a live order, but can clear an expired one
    let x = t.c.env.funded();
    t.c.env.fails_with(&[cancel_ix(&x.pubkey(), &t.m, &o.pubkey(), 2)], &[&x], "NotAuthorized");
    t.c.env.advance(601);
    assert!(t.execute_at(130 * USD, 2, Side::Long).is_err(), "expired orders don't fill");
    t.c.env.ok(&[cancel_ix(&x.pubkey(), &t.m, &o.pubkey(), 2)], &[&x]);
    let mm: MarginAccount = t.c.env.account(&t.m);
    assert_eq!(mm.collateral as u64, 1_000 * USDC);
}

#[test]
fn a_limit_needs_free_margin_for_its_reserve() {
    let mut t = T::new();
    let o = t.owner.insecure_clone();
    let expiry = t.c.env.now() + 600;
    // 10 × 145 at 1× needs 1,450 USDC of the 1,000 deposited
    let mut a = args(Side::Long, 145 * USD, expiry);
    a.leverage_x100 = 100;
    t.c.env.fails_with(&[place_ix(&o.pubkey(), &t.m, 1, a)], &[&o], "InsufficientMargin");
}
