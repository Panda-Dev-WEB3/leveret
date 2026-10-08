//! Staked $LVRT first-loss tranche (Backend §5).
//!
//! Stakes are shares of a per-bucket pool of $LVRT. A slash removes $LVRT
//! from the pool, so every share — including those cooling down for unstake —
//! loses value pro rata without touching individual stake accounts. Slashed
//! $LVRT is valued at the published TWAP less a recovery discount.
//!
//! Prices are USD per whole $LVRT (PRICE_SCALE); amounts are $LVRT base units
//! with `decimals`.

use crate::fixed::*;

pub const DEFAULT_TWAP_WINDOW_S: i64 = 30 * 60;
pub const DEFAULT_RECOVERY_DISCOUNT_BPS: i64 = 500;
/// Slashing needs a TWAP no older than this.
pub const MAX_TWAP_AGE_S: i64 = 3_600;

/// Time-weighted EMA: moves toward `price` by `min(dt, window) / window`.
/// The first observation seeds it.
pub fn ema_twap(prev: i64, price: i64, dt_s: i64, window_s: i64) -> MathResult<i64> {
    if price <= 0 || window_s <= 0 || dt_s < 0 {
        return Err(MathError::InvalidInput);
    }
    if prev <= 0 {
        return Ok(price);
    }
    let w = dt_s.min(window_s) as i128;
    to_i64(prev as i128 + mul_div(price as i128 - prev as i128, w, window_s as i128)?)
}

/// Price at which slashed $LVRT is valued and sold: TWAP × (1 − discount).
pub fn recovery_price(twap: i64, discount_bps: i64) -> MathResult<i64> {
    to_i64(twap as i128 - apply_bps_up(twap as i128, discount_bps)?)
}

fn unit(decimals: u8) -> i128 {
    10i128.pow(decimals as u32)
}

/// USDC (1e6) value of `lvrt` base units at `price`, rounded down.
pub fn value_usdc(lvrt: u64, price: i64, decimals: u8) -> MathResult<u64> {
    let usd_1e8 = mul_div(lvrt as i128, price as i128, unit(decimals))?;
    to_u64(usd_1e8 / (PRICE_SCALE as i128 / USDC_SCALE as i128))
}

/// USDC value rounded up (what a buyer pays for `lvrt`).
pub fn value_usdc_up(lvrt: u64, price: i64, decimals: u8) -> MathResult<u64> {
    let usd_1e8 = mul_div_up(lvrt as i128, price as i128, unit(decimals))?;
    let per = PRICE_SCALE as i128 / USDC_SCALE as i128;
    to_u64((usd_1e8 + per - 1) / per)
}

/// $LVRT base units worth at least `usdc` at `price`, rounded up.
pub fn lvrt_for_usdc(usdc: u64, price: i64, decimals: u8) -> MathResult<u64> {
    if price <= 0 {
        return Err(MathError::InvalidInput);
    }
    let usd_1e8 = usdc as i128 * (PRICE_SCALE as i128 / USDC_SCALE as i128);
    to_u64(mul_div_up(usd_1e8, unit(decimals), price as i128)?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slash {
    /// USDC of bad debt this slash covers (booked as the bucket's receivable).
    pub usdc: u64,
    /// $LVRT removed from the pool.
    pub lvrt: u64,
}

/// Cover up to `uncovered` USDC from a pool of `staked` $LVRT at `price`.
pub fn slash(uncovered: u64, staked: u64, price: i64, decimals: u8) -> MathResult<Slash> {
    if uncovered == 0 || staked == 0 {
        return Ok(Slash { usdc: 0, lvrt: 0 });
    }
    let capacity = value_usdc(staked, price, decimals)?;
    if uncovered >= capacity {
        return Ok(Slash { usdc: capacity, lvrt: staked });
    }
    let lvrt = lvrt_for_usdc(uncovered, price, decimals)?.min(staked);
    Ok(Slash { usdc: uncovered, lvrt })
}

/// Shares minted for staking `amount` into a pool of `staked` $LVRT and
/// `total_shares` shares (1:1 for an empty pool).
pub fn shares_for_stake(amount: u64, total_shares: u64, staked: u64) -> MathResult<u64> {
    if amount == 0 {
        return Err(MathError::InvalidInput);
    }
    if total_shares == 0 || staked == 0 {
        return Ok(amount);
    }
    to_u64(mul_div(amount as i128, total_shares as i128, staked as i128)?)
}

/// $LVRT backing `shares`, rounded down.
pub fn lvrt_for_shares(shares: u64, total_shares: u64, staked: u64) -> MathResult<u64> {
    if total_shares == 0 {
        return Ok(0);
    }
    to_u64(mul_div(shares as i128, staked as i128, total_shares as i128)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const D: u8 = 6;
    const ONE: u64 = 1_000_000; // 1 LVRT
    const P: i64 = 2 * PRICE_SCALE; // $2

    #[test]
    fn twap_follows_price_by_time() {
        assert_eq!(ema_twap(0, P, 0, 1_800).unwrap(), P);
        // a spike for 1 minute of a 30-minute window moves it 1/30 of the way
        let t = ema_twap(P, 32 * PRICE_SCALE, 60, 1_800).unwrap();
        assert_eq!(t, P + PRICE_SCALE);
        assert_eq!(ema_twap(P, 3 * P, 10_000, 1_800).unwrap(), 3 * P);
    }

    #[test]
    fn valuation_round_trips_conservatively() {
        assert_eq!(value_usdc(10 * ONE, P, D).unwrap(), 20 * USDC_SCALE as u64);
        let need = lvrt_for_usdc(7 * USDC_SCALE as u64 + 1, P, D).unwrap();
        assert!(value_usdc(need, P, D).unwrap() >= 7 * USDC_SCALE as u64 + 1);
        assert_eq!(recovery_price(P, 500).unwrap(), P * 95 / 100);
    }

    #[test]
    fn partial_and_full_slash() {
        let s = slash(30 * USDC_SCALE as u64, 100 * ONE, P, D).unwrap();
        assert_eq!(s, Slash { usdc: 30 * USDC_SCALE as u64, lvrt: 15 * ONE });
        // tranche worth $200 can't cover $500: everything goes, covers $200
        let w = slash(500 * USDC_SCALE as u64, 100 * ONE, P, D).unwrap();
        assert_eq!(w, Slash { usdc: 200 * USDC_SCALE as u64, lvrt: 100 * ONE });
        assert_eq!(slash(0, 100 * ONE, P, D).unwrap().lvrt, 0);
    }

    #[test]
    fn slashing_is_pro_rata_through_shares() {
        // A stakes 100, B stakes 300; 80 slashed → both lose 20%
        let a = shares_for_stake(100 * ONE, 0, 0).unwrap();
        let b = shares_for_stake(300 * ONE, a, 100 * ONE).unwrap();
        let (shares, staked) = (a + b, 400 * ONE - 80 * ONE);
        assert_eq!(lvrt_for_shares(a, shares, staked).unwrap(), 80 * ONE);
        assert_eq!(lvrt_for_shares(b, shares, staked).unwrap(), 240 * ONE);
        // a later staker buys in at the post-slash rate
        let c = shares_for_stake(80 * ONE, shares, staked).unwrap();
        assert_eq!(c, a);
    }
}
