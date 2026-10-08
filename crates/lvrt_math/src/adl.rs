//! Auto-deleveraging (Backend §3.5, last step of the loss waterfall).
//!
//! `ratio = trader uPnL / bucket available` where available = bucket USDC +
//! unsettled flows to the bucket + insurance fund. ADL may run once the ratio
//! reaches the trigger and closes winners at the mark until it is back at the
//! target. Closing a fraction `f` of a winner with PnL `p` realizes it: the
//! liability and the bucket's payable both fall by `f·p`, so
//! `(L − f·p) / (A − f·p)` falls toward the target while `L < A`.
//!
//! Rank = `pnl% × leverage` = (pnl / entry notional) × (entry notional /
//! margin) = pnl / margin, i.e. return on the position's margin.

use crate::fixed::*;

pub const DEFAULT_TRIGGER_BPS: u16 = 9_500;
pub const DEFAULT_TARGET_BPS: u16 = 9_000;
/// Rank precision: 1e6 = 100% return on margin.
pub const RANK_SCALE: i128 = 1_000_000;

/// Trader uPnL as bps of available capital; `i64::MAX` when nothing is available.
pub fn pnl_ratio_bps(liability: i64, available: i64) -> i64 {
    if available <= 0 {
        return if liability > 0 { i64::MAX } else { 0 };
    }
    ((liability as i128 * BPS as i128) / available as i128).clamp(i64::MIN as i128, i64::MAX as i128) as i64
}

pub fn is_triggered(liability: i64, available: i64, trigger_bps: u16) -> bool {
    liability > 0 && pnl_ratio_bps(liability, available) >= trigger_bps as i64
}

/// Return on margin, RANK_SCALE units.
pub fn rank(pnl: i64, margin: u64) -> MathResult<i128> {
    if margin == 0 {
        return Err(MathError::DivideByZero);
    }
    mul_div(pnl as i128, RANK_SCALE, margin as i128)
}

/// Smallest fraction (bps, rounded up, ≤ 100%) of a winner with PnL `p` to
/// close so that `(L − f·p) ≤ t·(A − f·p)`:  f ≥ (L − t·A) / (p·(1 − t)).
pub fn close_fraction_bps(liability: i64, available: i64, pnl: i64, target_bps: u16) -> MathResult<i64> {
    if pnl <= 0 || target_bps as i64 >= BPS {
        return Err(MathError::InvalidInput);
    }
    let t = target_bps as i128;
    let excess = liability as i128 * BPS as i128 - t * available as i128; // (L − tA)·BPS
    if excess <= 0 {
        return Ok(0);
    }
    let denom = pnl as i128 * (BPS as i128 - t); // p·(1 − t)·BPS
    let f = mul_div_up(excess, BPS as i128, denom)?;
    Ok(f.min(BPS as i128) as i64)
}

/// Net trader uPnL of a market from aggregated OI and entry notionals:
/// longs `oi·mark − entry`, shorts `entry − oi·mark`.
pub fn market_upnl(oi_long: u64, oi_short: u64, long_entry_notional: u64, short_entry_notional: u64, mark: i64) -> MathResult<i64> {
    let long_value = notional(oi_long as i64, mark)?;
    let short_value = notional(oi_short as i64, mark)?;
    to_i64(long_value as i128 - long_entry_notional as i128 + short_entry_notional as i128 - short_value as i128)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger() {
        assert!(!is_triggered(94, 100, DEFAULT_TRIGGER_BPS));
        assert!(is_triggered(95, 100, DEFAULT_TRIGGER_BPS));
        assert!(is_triggered(1, 0, DEFAULT_TRIGGER_BPS));
        assert!(!is_triggered(-50, 100, DEFAULT_TRIGGER_BPS));
    }

    #[test]
    fn rank_is_return_on_margin() {
        // same PnL, 5× less margin → 5× the rank
        assert_eq!(rank(500, 150).unwrap(), 3_333_333); // 333% on margin
        assert_eq!(rank(500, 750).unwrap(), 666_666);
        assert!(rank(1, 0).is_err());
    }

    #[test]
    fn fraction_lands_on_target() {
        let (l, a, p) = (998_500_000i64, 1_000_000_000i64, 499_250_000i64);
        assert_eq!(close_fraction_bps(l, a, p, 9_000).unwrap(), BPS); // needs > 100%
        let (l2, a2) = (l - p, a - p);
        let f = close_fraction_bps(l2, a2, p, 9_000).unwrap();
        assert!(f > 0 && f < BPS);
        let fp = (p as i128 * f as i128 / BPS as i128) as i64;
        let after = pnl_ratio_bps(l2 - fp, a2 - fp);
        assert!(after <= 9_000 + 1, "after {after}");
        assert_eq!(close_fraction_bps(80, 100, 10, 9_000).unwrap(), 0);
    }

    #[test]
    fn upnl() {
        // 10 long from $150 marked at $160, 4 short from $155 marked at $160
        let u = market_upnl(10 * BASE_SCALE as u64, 4 * BASE_SCALE as u64, 1_500 * USDC_SCALE as u64, 620 * USDC_SCALE as u64, 160 * PRICE_SCALE).unwrap();
        assert_eq!(u, (100 - 20) * USDC_SCALE);
    }
}
