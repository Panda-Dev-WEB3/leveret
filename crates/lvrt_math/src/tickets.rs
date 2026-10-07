//! Knock-out tickets (§9). Barrier = financing level F.
//!
//! Long:  V = max(0, S − F) · r, knocked out when S ≤ F
//! Short: V = max(0, F − S) · r, knocked out when S ≥ F
//! `r` is the ratio in base units (BASE_SCALE = 1 underlying unit).

use crate::corporate::Ratio;
use crate::fixed::*;

pub const MIN_DISTANCE_SESSION_BPS: i64 = 300;
pub const MIN_DISTANCE_OFF_HOURS_BPS: i64 = 800;
pub const SPREAD_MIN_BPS: i64 = 15;
pub const SPREAD_MAX_BPS: i64 = 50;
/// Stress budget: a 15% gap must not lose more than 25% of the bucket.
pub const STRESS_GAP_BPS: i64 = 1_500;
pub const STRESS_MAX_LOSS_BPS: i64 = 2_500;

pub fn is_knocked_out(side: Side, s: i64, f: i64) -> bool {
    match side {
        Side::Long => s <= f,
        Side::Short => s >= f,
    }
}

/// Intrinsic value in USDC.
pub fn ticket_value(side: Side, s: i64, f: i64, r: i64) -> MathResult<i64> {
    let diff = match side {
        Side::Long => s as i128 - f as i128,
        Side::Short => f as i128 - s as i128,
    };
    if diff <= 0 {
        return Ok(0);
    }
    to_i64(mul_div(diff, r as i128, PRICE_SCALE as i128)?)
}

/// Leverage ×100: S / |S − F|.
pub fn ticket_leverage_x100(s: i64, f: i64) -> MathResult<i64> {
    let d = (s as i128 - f as i128).abs();
    if d == 0 {
        return Err(MathError::DivideByZero);
    }
    to_i64(mul_div(s as i128, 100, d)?)
}

/// Barrier distance check against the session minimum.
pub fn distance_ok(s: i64, f: i64, in_session: bool) -> bool {
    let min = if in_session { MIN_DISTANCE_SESSION_BPS } else { MIN_DISTANCE_OFF_HOURS_BPS };
    if s <= 0 {
        return false;
    }
    let d = ((s as i128 - f as i128).abs() * BPS as i128) / s as i128;
    d >= min as i128
}

/// Lazy daily roll at 00:00 UTC: F × (1 + rate / 365) per elapsed day.
/// `annual_rate` is RATE_SCALE units per year and may be negative (shorts).
pub fn roll_financing(f: i64, annual_rate: i128, days: u32) -> MathResult<i64> {
    let mut x = f as i128;
    for _ in 0..days {
        x = x + mul_div(x, annual_rate, RATE_SCALE * 365)?;
    }
    to_i64(x)
}

/// Locked annual rate: long `base + spread_long`, short `base − spread_short`.
pub fn ticket_rate(side: Side, base: i128, spread_long: i128, spread_short: i128) -> i128 {
    match side {
        Side::Long => base + spread_long,
        Side::Short => base - spread_short,
    }
}

/// Price paid: `V(S_ask) + spread + gap_premium`, with S_ask = S(1 ± half_spread).
pub fn ticket_price(
    side: Side,
    s: i64,
    f: i64,
    r: i64,
    half_spread_bps: i64,
    spread_bps: i64,
    gap_premium: i64,
) -> MathResult<i64> {
    let adj = apply_bps(s as i128, half_spread_bps)?;
    let s_ask = to_i64(match side {
        Side::Long => s as i128 + adj,
        Side::Short => s as i128 - adj,
    })?;
    let v = ticket_value(side, s_ask, f, r)?;
    let notional_abs = notional(r, s)?.abs();
    let spread = to_i64(apply_bps_up(notional_abs as i128, spread_bps.clamp(SPREAD_MIN_BPS, SPREAD_MAX_BPS))?)?;
    Ok(v.saturating_add(spread).saturating_add(gap_premium))
}

/// Split: F / k, r × k.
pub fn split_ticket(f: i64, r: i64, k: Ratio) -> MathResult<(i64, i64)> {
    Ok((crate::corporate::split_price(f, k)?, crate::corporate::split_size(r, k)?))
}

/// Bucket loss on a ticket if the underlying gaps by `gap_bps` in the worst
/// direction for the bucket (i.e. in the ticket holder's favour).
pub fn stress_loss(side: Side, s: i64, f: i64, r: i64, gap_bps: i64) -> MathResult<i64> {
    let g = apply_bps(s as i128, gap_bps)?;
    let shocked = to_i64(match side {
        Side::Long => s as i128 + g,
        Side::Short => s as i128 - g,
    })?;
    Ok(ticket_value(side, shocked, f, r)? - ticket_value(side, s, f, r)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const S: i64 = 100 * PRICE_SCALE;
    const F: i64 = 90 * PRICE_SCALE;

    #[test]
    fn payoff_and_knockout() {
        assert_eq!(ticket_value(Side::Long, S, F, BASE_SCALE).unwrap(), 10 * USDC_SCALE);
        assert_eq!(ticket_value(Side::Long, F - 1, F, BASE_SCALE).unwrap(), 0);
        assert!(is_knocked_out(Side::Long, F, F));
        assert!(!is_knocked_out(Side::Short, F, 110 * PRICE_SCALE));
        assert_eq!(ticket_leverage_x100(S, F).unwrap(), 1_000); // 10×
    }

    #[test]
    fn distance() {
        assert!(distance_ok(S, 97 * PRICE_SCALE, true));
        assert!(!distance_ok(S, 98 * PRICE_SCALE, true));
        assert!(!distance_ok(S, 95 * PRICE_SCALE, false));
    }

    #[test]
    fn financing_rolls_barrier_up_for_longs() {
        let rate = ticket_rate(Side::Long, RATE_SCALE * 5 / 100, RATE_SCALE * 2 / 100, 0);
        let f1 = roll_financing(F, rate, 365).unwrap();
        assert!(f1 > F && f1 < F + F * 8 / 100);
        let short_rate = ticket_rate(Side::Short, RATE_SCALE / 100, 0, RATE_SCALE * 3 / 100);
        assert!(roll_financing(F, short_rate, 30).unwrap() < F);
    }

    #[test]
    fn price_includes_spread() {
        let p = ticket_price(Side::Long, S, F, BASE_SCALE, 0, 20, 0).unwrap();
        assert_eq!(p, 10 * USDC_SCALE + 200_000); // $10 + 20bps of $100
    }

    #[test]
    fn stress() {
        assert_eq!(stress_loss(Side::Long, S, F, BASE_SCALE, STRESS_GAP_BPS).unwrap(), 15 * USDC_SCALE);
    }
}
