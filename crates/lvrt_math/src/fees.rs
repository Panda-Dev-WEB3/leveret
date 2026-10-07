//! Trading fees and the 80/10/5/5 fee router split (Overview §5).

use crate::fixed::*;

pub const WORKERS_BPS: i64 = 8_000;
pub const TREASURY_BPS: i64 = 1_000;
pub const STAKERS_BPS: i64 = 500;
pub const BURN_BPS: i64 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct FeeSplit {
    /// LLP bucket share, after the insurance carve-out.
    pub lp: u64,
    pub insurance: u64,
    pub treasury: u64,
    pub stakers: u64,
    pub burn: u64,
}

impl FeeSplit {
    pub fn total(&self) -> u64 {
        self.lp + self.insurance + self.treasury + self.stakers + self.burn
    }
}

/// Split `fee` so that parts always sum to `fee` (rounding dust goes to LP).
/// `insurance_share_bps` is carved out of the 80% workers' share.
pub fn split_fee(fee: u64, insurance_share_bps: i64) -> MathResult<FeeSplit> {
    let f = fee as i128;
    let treasury = to_u64(apply_bps(f, TREASURY_BPS)?)?;
    let stakers = to_u64(apply_bps(f, STAKERS_BPS)?)?;
    let burn = to_u64(apply_bps(f, BURN_BPS)?)?;
    let workers = fee - treasury - stakers - burn;
    let insurance = to_u64(apply_bps(f, insurance_share_bps.clamp(0, WORKERS_BPS))?)?.min(workers);
    Ok(FeeSplit { lp: workers - insurance, insurance, treasury, stakers, burn })
}

/// Core/Stocks taker fee per side by $LVRT holding tier: 6 → 2.5 bps.
/// Returned in tenths of a bp (60 = 6 bps).
pub fn tier_fee_tenth_bps(tier: u8) -> i64 {
    match tier {
        0 => 60,
        1 => 50,
        2 => 40,
        3 => 32,
        _ => 25,
    }
}

/// Fee in USDC for `notional_abs` at `tenth_bps`.
pub fn trade_fee(notional_abs: i64, tenth_bps: i64) -> MathResult<u64> {
    to_u64(mul_div_up(notional_abs as i128, tenth_bps as i128, BPS as i128 * 10)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_sums_exactly() {
        for fee in [0u64, 1, 7, 999, 1_000_003] {
            for ins in [0, 500, 2_000] {
                let s = split_fee(fee, ins).unwrap();
                assert_eq!(s.total(), fee);
            }
        }
        let s = split_fee(10_000, 2_000).unwrap();
        assert_eq!((s.lp, s.insurance, s.treasury, s.stakers, s.burn), (6_000, 2_000, 1_000, 500, 500));
    }

    #[test]
    fn tiers() {
        assert_eq!(trade_fee(10_000 * USDC_SCALE, tier_fee_tenth_bps(0)).unwrap(), 6 * USDC_SCALE as u64);
        assert_eq!(trade_fee(10_000 * USDC_SCALE, tier_fee_tenth_bps(9)).unwrap(), 2_500_000);
    }
}
