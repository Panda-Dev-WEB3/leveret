//! Factor basket index level (§8).
//!
//! `I_t = I_reb · (1 + Σ w_i (S_i,t / S_i,reb − 1) − β (SPY_t / SPY_reb − 1))`
//! Weights and β are in bps (10_000 = 1.0).

use crate::fixed::*;

pub const MAX_CONSTITUENTS: usize = 32;
/// TRND per-name weight cap: 10%.
pub const WEIGHT_CAP_BPS: i64 = 1_000;
/// A stale constituent may hold its last price this long in session.
pub const STALE_HOLD_S: i64 = 6 * 3_600;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Constituent {
    pub weight_bps: i64,
    pub price_reb: i64,
    pub price_now: i64,
}

pub fn index_level(i_reb: i64, cs: &[Constituent], beta_bps: i64, spy_reb: i64, spy_now: i64) -> MathResult<i64> {
    if cs.len() > MAX_CONSTITUENTS || spy_reb <= 0 {
        return Err(MathError::InvalidInput);
    }
    // accumulate in PRICE_SCALE·BPS fixed point
    let one = PRICE_SCALE as i128 * BPS as i128;
    let mut acc: i128 = one;
    for c in cs {
        if c.price_reb <= 0 || c.price_now <= 0 {
            return Err(MathError::InvalidInput);
        }
        let ret = mul_div(c.price_now as i128 - c.price_reb as i128, PRICE_SCALE as i128, c.price_reb as i128)?;
        acc += ret * c.weight_bps as i128;
    }
    let spy_ret = mul_div(spy_now as i128 - spy_reb as i128, PRICE_SCALE as i128, spy_reb as i128)?;
    acc -= spy_ret * beta_bps as i128;
    to_i64(mul_div(i_reb as i128, acc, one)?)
}

/// Sum of weights must be 100% and each weight within the cap.
pub fn weights_valid(cs: &[Constituent], cap_bps: i64) -> bool {
    let sum: i64 = cs.iter().map(|c| c.weight_bps).sum();
    sum == BPS && cs.iter().all(|c| c.weight_bps > 0 && c.weight_bps <= cap_bps)
}

/// OI cap = 0.25 · min_i(depth2%_i / w_i), in USDC.
pub fn oi_cap(depth_2pct: &[i64], weights_bps: &[i64]) -> MathResult<i64> {
    if depth_2pct.len() != weights_bps.len() || depth_2pct.is_empty() {
        return Err(MathError::InvalidInput);
    }
    let mut min = i128::MAX;
    for (d, w) in depth_2pct.iter().zip(weights_bps) {
        if *w <= 0 {
            return Err(MathError::InvalidInput);
        }
        min = min.min(mul_div(*d as i128, BPS as i128, *w as i128)?);
    }
    to_i64(min / 4)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hedged_basket() {
        let p = 100 * PRICE_SCALE;
        let cs = [
            Constituent { weight_bps: 5_000, price_reb: p, price_now: p * 11 / 10 }, // +10%
            Constituent { weight_bps: 5_000, price_reb: p, price_now: p },           // flat
        ];
        // basket +5%, SPY +2% with β = 1 → +3%
        let lvl = index_level(1_000 * PRICE_SCALE, &cs, BPS, p, p * 102 / 100).unwrap();
        assert_eq!(lvl, 1_030 * PRICE_SCALE);
        assert!(weights_valid(&cs, 5_000));
        assert!(!weights_valid(&cs, WEIGHT_CAP_BPS));
    }

    #[test]
    fn cap() {
        assert_eq!(oi_cap(&[1_000_000, 4_000_000], &[1_000, 5_000]).unwrap(), 2_000_000);
    }
}
