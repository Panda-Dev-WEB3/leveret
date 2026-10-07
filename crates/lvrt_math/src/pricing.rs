//! Fill price: bid/ask floor, band-scaled spread and skew premium (§3.3).

use crate::fixed::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpreadParams {
    /// Base spread in bps (class / session dependent).
    pub base_bps: i64,
    /// Multiplier on the published band, in bps of the band (10_000 = 1×).
    pub k_band_bps: i64,
    /// Skew scale in base units; premium = (skew + size/2) / skew_scale.
    pub skew_scale: i64,
    /// Hard clamp on the skew premium, bps.
    pub max_premium_bps: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fill {
    pub price: i64,
    /// Effective one-way cost vs mid, in bps (never negative).
    pub spread_bps: i64,
    /// Spread cost in USDC (1e6) vs mid, never negative.
    pub spread_paid: i64,
}

/// Skew premium in bps: `(skew + delta/2) / skew_scale`, clamped.
/// `skew` and `delta` are signed base units (long > 0).
pub fn skew_premium_bps(skew: i64, delta: i64, p: &SpreadParams) -> MathResult<i64> {
    if p.skew_scale <= 0 {
        return Err(MathError::InvalidInput);
    }
    let mid_skew = skew as i128 + (delta as i128) / 2;
    let prem = mul_div(mid_skew, BPS as i128, p.skew_scale as i128)?;
    Ok(clamp_i128(prem, -(p.max_premium_bps as i128), p.max_premium_bps as i128) as i64)
}

/// Fill price for a trade of `size` (unsigned base units) in direction `side`
/// given the oracle quote, current aggregated `skew` and spread params.
/// `extra_bps` widens the spread (off-hours, WIDE closes, gap protocol).
pub fn fill_price(
    side: Side,
    size: i64,
    mid: i64,
    bid: i64,
    ask: i64,
    band_bps: u16,
    skew: i64,
    p: &SpreadParams,
    extra_bps: i64,
) -> MathResult<Fill> {
    if size <= 0 || mid <= 0 || bid <= 0 || ask < bid {
        return Err(MathError::InvalidInput);
    }
    let delta = side.sign() * size;
    let band_part = mul_div(band_bps as i128, p.k_band_bps as i128, BPS as i128)? as i64;
    let premium = skew_premium_bps(skew, delta, p)?;
    // directional spread: positive moves the price against the taker
    let spread = p.base_bps + band_part + extra_bps;
    let adj_bps = side.sign() * spread + premium;
    let model = to_i64(mid as i128 + mul_div(mid as i128, adj_bps as i128, BPS as i128)?)?;
    let price = match side {
        Side::Long => model.max(ask),
        Side::Short => model.min(bid),
    };
    if price <= 0 {
        return Err(MathError::InvalidInput);
    }
    let diff = (price as i128 - mid as i128).abs();
    let spread_bps = to_i64(mul_div(diff, BPS as i128, mid as i128)?)?;
    let spread_paid = to_i64(mul_div(diff, size as i128, PRICE_SCALE as i128)?)?;
    Ok(Fill { price, spread_bps, spread_paid })
}

/// Slippage guard: long fills must be ≤ `bound`, short fills ≥ `bound`.
pub fn within_user_bound(side: Side, fill_px: i64, bound: i64) -> bool {
    match side {
        Side::Long => fill_px <= bound,
        Side::Short => fill_px >= bound,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MID: i64 = 100 * PRICE_SCALE;
    fn params() -> SpreadParams {
        SpreadParams { base_bps: 5, k_band_bps: 5_000, skew_scale: 1_000_000 * BASE_SCALE, max_premium_bps: 200 }
    }

    #[test]
    fn long_pays_at_least_ask_short_gets_at_most_bid() {
        let bid = MID - PRICE_SCALE / 10; // 10 bps wide each side
        let ask = MID + PRICE_SCALE / 10;
        let l = fill_price(Side::Long, BASE_SCALE, MID, bid, ask, 0, 0, &params(), 0).unwrap();
        assert_eq!(l.price, ask);
        let s = fill_price(Side::Short, BASE_SCALE, MID, bid, ask, 0, 0, &params(), 0).unwrap();
        assert_eq!(s.price, bid);
    }

    #[test]
    fn spread_dominates_tight_quote() {
        let f = fill_price(Side::Long, BASE_SCALE, MID, MID, MID, 20, 0, &params(), 0).unwrap();
        // base 5 + 0.5 × 20 band = 15 bps
        assert_eq!(f.spread_bps, 15);
        assert_eq!(f.price, MID + MID * 15 / BPS);
    }

    #[test]
    fn skew_premium_charges_crowded_side() {
        let p = params();
        let crowded = fill_price(Side::Long, BASE_SCALE, MID, MID, MID, 0, 500_000 * BASE_SCALE, &p, 0).unwrap();
        let neutral = fill_price(Side::Long, BASE_SCALE, MID, MID, MID, 0, 0, &p, 0).unwrap();
        assert!(crowded.price > neutral.price);
        // a short into long skew is helped by the premium but still floored at bid
        let s = fill_price(Side::Short, BASE_SCALE, MID, MID, MID, 0, 500_000 * BASE_SCALE, &p, 0).unwrap();
        assert_eq!(s.price, MID);
    }

    #[test]
    fn user_bound() {
        assert!(within_user_bound(Side::Long, 100, 101));
        assert!(!within_user_bound(Side::Short, 100, 101));
    }
}
