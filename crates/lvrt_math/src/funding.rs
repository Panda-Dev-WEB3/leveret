//! Velocity funding and utilization borrow (§3.4).
//!
//! `rate` is a fraction per day scaled by [`RATE_SCALE`]; positive means longs
//! pay shorts. `funding_index` accumulates `rate · dt · mid` in price units
//! scaled by [`FUNDING_PRECISION`], so a position's funding owed is
//! `sign · size · Δindex / (PRICE_SCALE · FUNDING_PRECISION)` USDC.

use crate::fixed::*;

pub const FUNDING_PRECISION: i128 = 1_000_000;

/// ±0.05% per 8h = ±0.15% per day, the off-hours clamp.
pub const OFF_HOURS_MAX_RATE: i128 = RATE_SCALE * 15 / 10_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FundingParams {
    /// Max change of rate per day, RATE_SCALE units.
    pub max_velocity: i128,
    /// Skew (base units) at which velocity saturates.
    pub skew_scale: i64,
    /// Absolute cap on the rate, RATE_SCALE units per day.
    pub max_rate: i128,
    /// Small Caps only: extra rate `k · (oi_long − oi_short) / oi_total`.
    pub imbalance_k: i128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FundingUpdate {
    pub rate: i128,
    pub index: i128,
}

/// Advance funding by `dt_s` seconds.
/// `in_session = false` holds the rate (clamped to the off-hours bound).
pub fn accrue_funding(
    rate: i128,
    index: i128,
    skew: i64,
    oi_long: i64,
    oi_short: i64,
    mid: i64,
    dt_s: i64,
    in_session: bool,
    p: &FundingParams,
) -> MathResult<FundingUpdate> {
    if dt_s < 0 || p.skew_scale <= 0 {
        return Err(MathError::InvalidInput);
    }
    if dt_s == 0 {
        return Ok(FundingUpdate { rate, index });
    }
    let day = SECONDS_PER_DAY as i128;
    let new_rate = if in_session {
        let frac = clamp_i128(mul_div(skew as i128, RATE_SCALE, p.skew_scale as i128)?, -RATE_SCALE, RATE_SCALE);
        let dr = mul_div(mul_div(p.max_velocity, frac, RATE_SCALE)?, dt_s as i128, day)?;
        clamp_i128(rate + dr, -p.max_rate, p.max_rate)
    } else {
        clamp_i128(rate, -OFF_HOURS_MAX_RATE, OFF_HOURS_MAX_RATE)
    };
    let imbalance = {
        let total = oi_long as i128 + oi_short as i128;
        if p.imbalance_k != 0 && total > 0 {
            mul_div(p.imbalance_k, oi_long as i128 - oi_short as i128, total)?
        } else {
            0
        }
    };
    // trapezoid on the rate over the interval
    let avg_rate = (rate + new_rate) / 2 + imbalance;
    let d_index = mul_div(
        mul_div(avg_rate, mid as i128 * FUNDING_PRECISION, RATE_SCALE)?,
        dt_s as i128,
        day,
    )?;
    Ok(FundingUpdate { rate: new_rate, index: index.checked_add(d_index).ok_or(MathError::Overflow)? })
}

/// Funding owed (USDC, positive = trader pays) for a signed position size.
pub fn funding_owed(signed_size: i64, entry_index: i128, current_index: i128) -> MathResult<i64> {
    let d = current_index.checked_sub(entry_index).ok_or(MathError::Overflow)?;
    to_i64(mul_div(signed_size as i128, d, PRICE_SCALE as i128 * FUNDING_PRECISION)?)
}

/// Borrow rate per hour in bps×100 (1e-6 per hour): `base + slope · utilization`.
pub fn borrow_rate(base: i64, slope: i64, utilization_bps: i64) -> MathResult<i64> {
    to_i64(base as i128 + mul_div(slope as i128, utilization_bps.clamp(0, BPS) as i128, BPS as i128)?)
}

/// Borrow accrued on `notional_abs` USDC over `dt_s` at `rate_ppm_per_hour`.
pub fn borrow_accrued(notional_abs: i64, rate_ppm_per_hour: i64, dt_s: i64) -> MathResult<i64> {
    to_i64(mul_div_up(
        mul_div(notional_abs as i128, rate_ppm_per_hour as i128, 1_000_000)?,
        dt_s as i128,
        3_600,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> FundingParams {
        FundingParams { max_velocity: RATE_SCALE / 100, skew_scale: 1_000 * BASE_SCALE, max_rate: RATE_SCALE / 10, imbalance_k: 0 }
    }

    #[test]
    fn long_skew_drives_rate_up_and_longs_pay() {
        let mid = 100 * PRICE_SCALE;
        let u = accrue_funding(0, 0, 1_000 * BASE_SCALE, 0, 0, mid, SECONDS_PER_DAY, true, &p()).unwrap();
        assert_eq!(u.rate, RATE_SCALE / 100); // +1%/day after one day at full skew
        // avg rate 0.5% over 1 day on $100 → $0.50 per unit
        let owed = funding_owed(BASE_SCALE, 0, u.index).unwrap();
        assert_eq!(owed, USDC_SCALE / 2);
        assert_eq!(funding_owed(-BASE_SCALE, 0, u.index).unwrap(), -USDC_SCALE / 2);
    }

    #[test]
    fn off_hours_holds_and_clamps() {
        let u = accrue_funding(RATE_SCALE / 100, 0, 1_000 * BASE_SCALE, 0, 0, PRICE_SCALE, 3_600, false, &p()).unwrap();
        assert_eq!(u.rate, OFF_HOURS_MAX_RATE);
    }

    #[test]
    fn borrow() {
        assert_eq!(borrow_rate(10, 90, 5_000).unwrap(), 55);
        // $10k notional × 100 ppm/h × 1h = $1
        assert_eq!(borrow_accrued(10_000 * USDC_SCALE, 100, 3_600).unwrap(), USDC_SCALE);
    }
}
