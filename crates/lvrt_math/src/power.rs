//! Squared (power p = 2) and ratio perps (§7).
//!
//! `I = S² / PRICE_SCALE` keeps the index in price units. A PowerToken
//! balance (1e6) is worth `balance × norm_factor × I` USDC with `norm_factor`
//! scaled by [`NORM_SCALE`].

use crate::corporate::Ratio;
use crate::fixed::*;

/// Max funding: 0.5%/day in session, 0.05%/day off-hours.
pub const F_MAX_SESSION: i128 = RATE_SCALE * 50 / 10_000;
pub const F_MAX_OFF_HOURS: i128 = RATE_SCALE * 5 / 10_000;

/// AMM quote band: ±1% in session, ±3% off-hours.
pub const AMM_BAND_SESSION_BPS: i64 = 100;
pub const AMM_BAND_OFF_HOURS_BPS: i64 = 300;
pub const AMM_FEE_BPS: i64 = 10;

/// ShortVault ratios (bps of debt).
pub const SHORT_MINT_CR_BPS: i64 = 20_000;
pub const SHORT_MAINTAIN_CR_BPS: i64 = 15_000;
pub const SHORT_FULL_CLOSE_CR_BPS: i64 = 12_000;
pub const SHORT_OFF_HOURS_LIQ_CR_BPS: i64 = 12_500;
pub const SHORT_LIQ_BONUS_BPS: i64 = 500;
pub const SHORT_CLOSE_FACTOR_BPS: i64 = 5_000;

pub fn power_index(s: i64) -> MathResult<i64> {
    if s <= 0 {
        return Err(MathError::InvalidInput);
    }
    to_i64(mul_div(s as i128, s as i128, PRICE_SCALE as i128)?)
}

/// Ratio index `(P1 / P2) · PRICE_SCALE`.
pub fn ratio_index(p1: i64, p2: i64) -> MathResult<i64> {
    if p1 <= 0 || p2 <= 0 {
        return Err(MathError::InvalidInput);
    }
    to_i64(mul_div(p1 as i128, PRICE_SCALE as i128, p2 as i128)?)
}

/// Daily funding `f = clamp((M − I) / I, −f_max, f_max)`, RATE_SCALE units.
pub fn power_funding(mark: i64, index: i64, f_max: i128) -> MathResult<i128> {
    if index <= 0 {
        return Err(MathError::InvalidInput);
    }
    Ok(clamp_i128(mul_div(mark as i128 - index as i128, RATE_SCALE, index as i128)?, -f_max, f_max))
}

/// `nf(t+dt) = nf(t) · (1 − f · dt / 1 day)`.
pub fn accrue_norm_factor(nf: i128, f: i128, dt_s: i64) -> MathResult<i128> {
    if dt_s < 0 {
        return Err(MathError::InvalidInput);
    }
    let decay = mul_div(f, dt_s as i128, SECONDS_PER_DAY as i128)?; // RATE_SCALE units
    let r = mul_div(nf, RATE_SCALE - decay, RATE_SCALE)?;
    if r <= 0 {
        return Err(MathError::Overflow);
    }
    Ok(r)
}

/// Carry in bps per day shown in the UI (positive = longs pay).
pub fn daily_carry_bps(f: i128) -> i64 {
    (f * BPS as i128 / RATE_SCALE) as i64
}

/// Value in USDC of `balance` PowerTokens (or short debt for `minted`).
pub fn position_value(balance: u64, nf: i128, index: i64) -> MathResult<i64> {
    // multiply by the index first: truncating `balance × nf` early loses up to
    // 1/balance of precision, which breaks split invariance for small balances
    let v = mul_div(balance as i128, index as i128, PRICE_SCALE as i128)?;
    to_i64(mul_div(v, nf, NORM_SCALE)?)
}

/// Split k: S → S/k so I → I/k²; norm_factor × k² keeps every value.
pub fn split_norm_factor(nf: i128, k: Ratio) -> MathResult<i128> {
    k.validate()?;
    let n2 = (k.num as i128) * (k.num as i128);
    let d2 = (k.den as i128) * (k.den as i128);
    mul_div(nf, n2, d2)
}

/// Allowed AMM quote range `[I(1 − b), I(1 + b)]`.
pub fn amm_band(index: i64, band_bps: i64) -> MathResult<(i64, i64)> {
    let d = apply_bps(index as i128, band_bps)?;
    Ok((to_i64(index as i128 - d)?, to_i64(index as i128 + d)?))
}

/// Constant-product buy of `usdc_in` (10 bps fee) against reserves, returning
/// tokens out, or `None` when the price paid would be above `I(1 + b)` (route
/// to ShortVault mint) or the pool can't fill. A pool quoting below `I(1 − b)`
/// fills at `I(1 − b)`: nothing leaves the AMM under the band, so its
/// inventory can't be bought cheap and sold back at the floor.
pub fn amm_buy(usdc_reserve: u64, token_reserve: u64, usdc_in: u64, nf: i128, index: i64, band_bps: i64) -> MathResult<Option<u64>> {
    if usdc_reserve == 0 || token_reserve == 0 || usdc_in == 0 {
        return Ok(None);
    }
    let fee = apply_bps_up(usdc_in as i128, AMM_FEE_BPS)?;
    let net = usdc_in as i128 - fee;
    let k = usdc_reserve as i128 * token_reserve as i128;
    let new_tok = div_up(k, usdc_reserve as i128 + net)?;
    let curve = token_reserve as i128 - new_tok;
    if curve <= 0 {
        return Ok(None);
    }
    // effective per-token-unit price in index terms: usdc / (tokens × nf)
    let eff = effective_index(net, curve, nf)?;
    let (lo, hi) = amm_band(index, band_bps)?;
    if eff > hi as i128 {
        return Ok(None);
    }
    let out = if eff < lo as i128 { tokens_at(net, lo, nf)? } else { curve };
    if out <= 0 || out >= token_reserve as i128 {
        return Ok(None);
    }
    Ok(Some(out as u64))
}

/// Constant-product sell of `tokens_in`, returning USDC out after the 10 bps
/// fee. Always fills at `≥ I(1 − b)` (the floor, paid from the AMM's USDC);
/// `None` when the AMM's USDC side can't cover it (route to Crab redeem).
pub fn amm_sell(usdc_reserve: u64, token_reserve: u64, tokens_in: u64, nf: i128, index: i64, band_bps: i64) -> MathResult<Option<u64>> {
    if usdc_reserve == 0 || token_reserve == 0 || tokens_in == 0 {
        return Ok(None);
    }
    let k = usdc_reserve as i128 * token_reserve as i128;
    let new_usdc = div_up(k, token_reserve as i128 + tokens_in as i128)?;
    let curve = usdc_reserve as i128 - new_usdc;
    let (lo, _) = amm_band(index, band_bps)?;
    let floor = usdc_at(tokens_in as i128, lo, nf)?;
    let gross = curve.max(floor);
    let out = gross - apply_bps_up(gross, AMM_FEE_BPS)?;
    if out <= 0 || gross >= usdc_reserve as i128 {
        return Ok(None);
    }
    Ok(Some(out as u64))
}

/// Tokens bought by `usdc` at index-equivalent price `price` (rounds down).
fn tokens_at(usdc: i128, price: i64, nf: i128) -> MathResult<i128> {
    mul_div(mul_div(usdc, PRICE_SCALE as i128, price as i128)?, NORM_SCALE, nf)
}

/// USDC paid for `tokens` at index-equivalent price `price` (rounds down).
fn usdc_at(tokens: i128, price: i64, nf: i128) -> MathResult<i128> {
    mul_div(mul_div(tokens, price as i128, PRICE_SCALE as i128)?, nf, NORM_SCALE)
}

fn div_up(n: i128, d: i128) -> MathResult<i128> {
    mul_div_up(n, 1, d)
}

/// Index-equivalent price paid: `usdc · PRICE_SCALE · NORM / (tokens · nf)`.
pub fn effective_index(usdc: i128, tokens: i128, nf: i128) -> MathResult<i128> {
    mul_div(mul_div(usdc, PRICE_SCALE as i128, tokens)?, NORM_SCALE, nf)
}

/// Collateral ratio of a short vault in bps.
pub fn collateral_ratio_bps(collateral: i64, debt_value: i64) -> i64 {
    if debt_value <= 0 {
        return i64::MAX;
    }
    ((collateral as i128 * BPS as i128) / debt_value as i128).min(i64::MAX as i128) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_and_funding() {
        let s = 200 * PRICE_SCALE;
        assert_eq!(power_index(s).unwrap(), 40_000 * PRICE_SCALE);
        let i = power_index(s).unwrap();
        let f = power_funding(i + i / 100, i, F_MAX_SESSION).unwrap();
        assert_eq!(f, F_MAX_SESSION); // 1% premium clamped to 0.5%/day
        assert_eq!(daily_carry_bps(f), 50);
    }

    #[test]
    fn norm_factor_decays_when_longs_pay() {
        let nf = accrue_norm_factor(NORM_SCALE, F_MAX_SESSION, SECONDS_PER_DAY).unwrap();
        assert_eq!(nf, NORM_SCALE - NORM_SCALE / 200);
    }

    /// §14 fixture: a power-market split keeps every long's value unchanged to 1e-9.
    #[test]
    fn split_keeps_value_to_1e9() {
        let bal = 1_234_567_890u64;
        let nf = accrue_norm_factor(NORM_SCALE, F_MAX_SESSION / 3, 12_345).unwrap();
        for k in [Ratio { num: 4, den: 1 }, Ratio { num: 1, den: 10 }, Ratio { num: 3, den: 2 }] {
            let s = 912_345_678_901i64;
            let before = position_value(bal, nf, power_index(s).unwrap()).unwrap();
            let s2 = crate::corporate::split_price(s, k).unwrap();
            let after = position_value(bal, split_norm_factor(nf, k).unwrap(), power_index(s2).unwrap()).unwrap();
            let rel = ((before - after).abs() as f64) / (before as f64);
            assert!(rel <= 1e-9, "k={k:?} before={before} after={after} rel={rel}");
        }
    }

    #[test]
    fn amm_respects_band() {
        let i = power_index(100 * PRICE_SCALE).unwrap(); // 10_000
        // reserves priced exactly at index: 1 token (1e6) = $10_000
        let tok = 1_000 * 1_000_000u64;
        let usdc = (10_000 * 1_000 * USDC_SCALE) as u64;
        assert!(amm_buy(usdc, tok, (1_000 * USDC_SCALE) as u64, NORM_SCALE, i, 100).unwrap().is_some());
        // a buy that moves price > 1% is refused (routes to ShortVault mint)
        assert!(amm_buy(usdc, tok, (500_000 * USDC_SCALE) as u64, NORM_SCALE, i, 100).unwrap().is_none());
    }

    #[test]
    fn amm_buy_never_fills_under_the_band() {
        let i = power_index(100 * PRICE_SCALE).unwrap();
        // pool quotes 5% under the index (the index moved up since it last traded)
        let tok = 1_000 * 1_000_000u64;
        let usdc = (9_500 * 1_000 * USDC_SCALE) as u64;
        let usdc_in = (10_000 * USDC_SCALE) as u64;
        let out = amm_buy(usdc, tok, usdc_in, NORM_SCALE, i, 100).unwrap().unwrap();
        let net = usdc_in as i128 - apply_bps_up(usdc_in as i128, AMM_FEE_BPS).unwrap();
        let paid = effective_index(net, out as i128, NORM_SCALE).unwrap();
        let (lo, _) = amm_band(i, 100).unwrap();
        assert!(paid >= lo as i128, "paid {paid} < floor {lo}");
    }

    #[test]
    fn amm_sell_fills_at_the_floor_or_better() {
        let i = power_index(100 * PRICE_SCALE).unwrap();
        let tok = 1_000 * 1_000_000u64;
        let usdc = (10_000 * 1_000 * USDC_SCALE) as u64;
        let (lo, _) = amm_band(i, 100).unwrap();
        let floor_of = |t: u64| usdc_at(t as i128, lo, NORM_SCALE).unwrap();
        // small sell: curve price, inside the band
        let t = 1_000_000;
        let out = amm_sell(usdc, tok, t, NORM_SCALE, i, 100).unwrap().unwrap() as i128;
        assert!(out > floor_of(t) - apply_bps_up(floor_of(t), AMM_FEE_BPS).unwrap());
        // big sell: the curve would pay ~9% under; the floor pays I(1 − 1%) less fee
        let t = 100 * 1_000_000;
        let out = amm_sell(usdc, tok, t, NORM_SCALE, i, 100).unwrap().unwrap() as i128;
        let floor = floor_of(t);
        assert_eq!(out, floor - apply_bps_up(floor, AMM_FEE_BPS).unwrap());
        // more than the USDC side holds: refused (Crab redeem)
        assert!(amm_sell(usdc, tok, 2_000 * 1_000_000, NORM_SCALE, i, 100).unwrap().is_none());
        // round trip never profits
        let usdc_in = (50_000 * USDC_SCALE) as u64;
        let got = amm_buy(usdc, tok, usdc_in, NORM_SCALE, i, 100).unwrap().unwrap();
        let back = amm_sell(usdc + usdc_in, tok - got, got, NORM_SCALE, i, 100).unwrap().unwrap();
        assert!(back < usdc_in);
    }

    #[test]
    fn ratio() {
        assert_eq!(ratio_index(200 * PRICE_SCALE, 100 * PRICE_SCALE).unwrap(), 2 * PRICE_SCALE);
        assert_eq!(collateral_ratio_bps(300, 100), 30_000);
    }
}
