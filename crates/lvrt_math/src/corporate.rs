//! Corporate actions on equity markets (§3.6).
//!
//! A split of ratio k = `num / den` (2-for-1 → 2/1, 1-for-10 reverse → 1/10)
//! multiplies sizes by k and divides prices by k, keeping notional constant.

use crate::fixed::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ratio {
    pub num: u32,
    pub den: u32,
}

impl Ratio {
    pub fn validate(&self) -> MathResult<()> {
        if self.num == 0 || self.den == 0 {
            Err(MathError::InvalidInput)
        } else {
            Ok(())
        }
    }
}

pub fn split_size(size: i64, k: Ratio) -> MathResult<i64> {
    k.validate()?;
    to_i64(mul_div(size as i128, k.num as i128, k.den as i128)?)
}

pub fn split_price(px: i64, k: Ratio) -> MathResult<i64> {
    k.validate()?;
    to_i64(mul_div(px as i128, k.den as i128, k.num as i128)?)
}

/// Expected post-split reference used to reopen the market:
/// first fresh price must be within maxDev of `prev_close / k`.
pub fn post_split_reference(prev_close: i64, k: Ratio) -> MathResult<i64> {
    split_price(prev_close, k)
}

/// Cash dividend: longs credited `D × size`, shorts debited the same.
/// `dividend_per_share` uses PRICE_SCALE; result in USDC, signed for the trader.
pub fn dividend_adjustment(signed_size: i64, dividend_per_share: i64) -> MathResult<i64> {
    notional(signed_size, dividend_per_share)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_preserves_notional() {
        let k = Ratio { num: 10, den: 1 };
        let size = 3 * BASE_SCALE;
        let px = 1_200 * PRICE_SCALE;
        let before = notional(size, px).unwrap();
        let after = notional(split_size(size, k).unwrap(), split_price(px, k).unwrap()).unwrap();
        assert_eq!(before, after);
    }

    #[test]
    fn reverse_split() {
        let k = Ratio { num: 1, den: 10 };
        assert_eq!(split_size(10 * BASE_SCALE, k).unwrap(), BASE_SCALE);
        assert_eq!(split_price(PRICE_SCALE, k).unwrap(), 10 * PRICE_SCALE);
    }

    #[test]
    fn dividends() {
        assert_eq!(dividend_adjustment(100 * BASE_SCALE, PRICE_SCALE / 4).unwrap(), 25 * USDC_SCALE);
        assert_eq!(dividend_adjustment(-100 * BASE_SCALE, PRICE_SCALE / 4).unwrap(), -25 * USDC_SCALE);
    }
}
