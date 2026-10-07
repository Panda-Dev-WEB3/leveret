//! Margin, PnL, liquidation sizing and the anti-staleness / circuit-breaker
//! rules (§3.3, §3.5, §12).

use crate::fixed::*;

/// Leverage is expressed ×100 (5_000 = 50×).
pub const LEV_SCALE: i64 = 100;

/// Liquidation closes 25% per call, 100% when equity < 50% of maintenance.
pub const PARTIAL_CLOSE_BPS: i64 = 2_500;
pub const FULL_CLOSE_THRESHOLD_BPS: i64 = 5_000;

/// Liquidator bounty band (bps of closed notional).
pub const BOUNTY_MIN_BPS: i64 = 50;
pub const BOUNTY_MAX_BPS: i64 = 150;

/// Anti-staleness: closes within this many seconds of open only realize
/// profit beyond `ANTI_STALE_SPREAD_MULT ×` the spread paid.
pub const ANTI_STALE_WINDOW_S: i64 = 10;
pub const ANTI_STALE_SPREAD_MULT: i64 = 3;

/// Circuit breaker: realized profit above this per account per hour is queued.
pub const CIRCUIT_BREAKER_USDC: i64 = 250_000 * USDC_SCALE;
pub const CIRCUIT_BREAKER_WINDOW_S: i64 = 3_600;
pub const CIRCUIT_BREAKER_DELAY_S: i64 = 3_600;

/// Initial margin for `notional_abs` at `leverage_x100`.
pub fn initial_margin(notional_abs: i64, leverage_x100: i64) -> MathResult<i64> {
    if leverage_x100 < LEV_SCALE {
        return Err(MathError::InvalidInput);
    }
    to_i64(mul_div_up(notional_abs as i128, LEV_SCALE as i128, leverage_x100 as i128)?)
}

pub fn maintenance_margin(notional_abs: i64, mm_bps: i64) -> MathResult<i64> {
    to_i64(apply_bps_up(notional_abs as i128, mm_bps)?)
}

/// Unrealized PnL in USDC for a signed size opened at `entry`, marked at `mark`.
pub fn unrealized_pnl(signed_size: i64, entry: i64, mark: i64) -> MathResult<i64> {
    to_i64(mul_div(signed_size as i128, mark as i128 - entry as i128, PRICE_SCALE as i128)?)
}

/// Equity = collateral + uPnL − funding owed − borrow owed.
pub fn equity(collateral: i64, upnl: i64, funding_owed: i64, borrow_owed: i64) -> i64 {
    collateral.saturating_add(upnl).saturating_sub(funding_owed).saturating_sub(borrow_owed)
}

pub fn is_liquidatable(equity: i64, maintenance: i64) -> bool {
    equity < maintenance
}

/// Fraction of the position (bps) a single liquidation call may close.
pub fn liquidation_close_bps(equity: i64, maintenance: i64) -> i64 {
    if maintenance <= 0 {
        return 0;
    }
    if (equity as i128) * (BPS as i128) < (maintenance as i128) * (FULL_CLOSE_THRESHOLD_BPS as i128) {
        BPS
    } else {
        PARTIAL_CLOSE_BPS
    }
}

/// Bounty scales linearly from MIN at equity == maintenance to MAX at
/// equity <= 0, then is capped in absolute USDC.
pub fn liquidation_bounty(closed_notional_abs: i64, equity: i64, maintenance: i64, cap: i64) -> MathResult<i64> {
    let depth_bps = if maintenance <= 0 {
        BPS
    } else {
        clamp_i128(
            mul_div(maintenance as i128 - equity as i128, BPS as i128, maintenance as i128)?,
            0,
            BPS as i128,
        ) as i64
    };
    let bps = BOUNTY_MIN_BPS + (BOUNTY_MAX_BPS - BOUNTY_MIN_BPS) * depth_bps / BPS;
    Ok(to_i64(apply_bps(closed_notional_abs as i128, bps)?)?.min(cap))
}

/// Liquidation price of an isolated position with `collateral` (already net of
/// accrued funding/borrow). Returns `None` when the position can't be
/// liquidated by price alone (e.g. a short with collateral ≥ unlimited, never
/// in practice, or a long whose collateral covers the full notional).
///
/// Long:  c + s(p − e) = m·s·p  ⇒  p = (s·e − c) / (s·(1 − m))
/// Short: c − s(p − e) = m·s·p  ⇒  p = (s·e + c) / (s·(1 + m))
pub fn liquidation_price(side: Side, size_abs: i64, entry: i64, collateral: i64, mm_bps: i64) -> Option<i64> {
    if size_abs <= 0 {
        return None;
    }
    let s = size_abs as i128;
    let e = entry as i128;
    // collateral in price·size units: c × PRICE_SCALE
    let c = collateral as i128 * PRICE_SCALE as i128;
    let (num, den) = match side {
        Side::Long => (s * e - c, s * (BPS - mm_bps) as i128),
        Side::Short => (s * e + c, s * (BPS + mm_bps) as i128),
    };
    if den <= 0 || num <= 0 {
        return None;
    }
    i64::try_from(num * BPS as i128 / den).ok()
}

/// Realizable PnL after the anti-staleness edge.
pub fn anti_stale_realized(pnl: i64, spread_paid: i64, held_s: i64) -> i64 {
    if held_s >= ANTI_STALE_WINDOW_S || pnl <= 0 {
        return pnl;
    }
    let hurdle = spread_paid.saturating_mul(ANTI_STALE_SPREAD_MULT);
    (pnl - hurdle).max(0)
}

/// Split realized profit into (paid now, queued for one hour) given what has
/// already been paid this window.
pub fn circuit_breaker_split(profit: i64, paid_this_window: i64) -> (i64, i64) {
    if profit <= 0 {
        return (profit, 0);
    }
    let room = (CIRCUIT_BREAKER_USDC - paid_this_window).max(0);
    let now = profit.min(room);
    (now, profit - now)
}

#[cfg(test)]
mod tests {
    use super::*;

    const E: i64 = 100 * PRICE_SCALE;

    #[test]
    fn margins() {
        assert_eq!(initial_margin(10_000 * USDC_SCALE, 50 * LEV_SCALE).unwrap(), 200 * USDC_SCALE);
        assert_eq!(maintenance_margin(10_000 * USDC_SCALE, 100).unwrap(), 100 * USDC_SCALE);
        assert!(initial_margin(1, 50).is_err());
    }

    #[test]
    fn pnl_signs() {
        assert_eq!(unrealized_pnl(BASE_SCALE, E, E + PRICE_SCALE).unwrap(), USDC_SCALE);
        assert_eq!(unrealized_pnl(-BASE_SCALE, E, E + PRICE_SCALE).unwrap(), -USDC_SCALE);
    }

    #[test]
    fn close_fraction_and_bounty() {
        assert_eq!(liquidation_close_bps(90, 100), PARTIAL_CLOSE_BPS);
        assert_eq!(liquidation_close_bps(49, 100), BPS);
        assert_eq!(liquidation_bounty(1_000_000, 100, 100, i64::MAX).unwrap(), 5_000);
        assert_eq!(liquidation_bounty(1_000_000, 0, 100, i64::MAX).unwrap(), 15_000);
        assert_eq!(liquidation_bounty(1_000_000, 0, 100, 1_000).unwrap(), 1_000);
    }

    #[test]
    fn liq_price_is_where_equity_hits_maintenance() {
        // 10 units long at $100, $100 collateral (10×), 1% MM
        let size = 10 * BASE_SCALE;
        let c = 100 * USDC_SCALE;
        let p = liquidation_price(Side::Long, size, E, c, 100).unwrap();
        let eq = equity(c, unrealized_pnl(size, E, p).unwrap(), 0, 0);
        let mm = maintenance_margin(notional(size, p).unwrap(), 100).unwrap();
        assert!((eq - mm).abs() <= 2, "eq {eq} mm {mm}");
        let ps = liquidation_price(Side::Short, size, E, c, 100).unwrap();
        assert!(ps > E && p < E);
    }

    #[test]
    fn anti_staleness() {
        assert_eq!(anti_stale_realized(100, 20, 3), 40);
        assert_eq!(anti_stale_realized(50, 20, 3), 0);
        assert_eq!(anti_stale_realized(-50, 20, 3), -50);
        assert_eq!(anti_stale_realized(100, 20, 10), 100);
    }

    #[test]
    fn circuit_breaker() {
        assert_eq!(circuit_breaker_split(100, 0), (100, 0));
        let (now, q) = circuit_breaker_split(300_000 * USDC_SCALE, 0);
        assert_eq!(now, CIRCUIT_BREAKER_USDC);
        assert_eq!(q, 50_000 * USDC_SCALE);
    }
}
