//! LLP bucket NAV, share mint/redeem and withdrawal rules (§4, §5).

use crate::fixed::*;

pub const MINT_REDEEM_FEE_BPS: i64 = 5;
pub const INSTANT_WITHDRAW_MAX_UTIL_BPS: i64 = 5_000;
pub const WITHDRAW_QUEUE_S: i64 = 48 * 3_600;
/// First deposit mints shares 1:1 with USDC; this many are locked forever to
/// defeat share-price inflation on an empty bucket.
pub const DEAD_SHARES: u64 = 1_000;

/// NAV = USDC + accrued fees − unrealized trader PnL − pending payouts.
pub fn nav(usdc: i64, accrued_fees: i64, trader_upnl: i64, pending_payouts: i64) -> i64 {
    usdc.saturating_add(accrued_fees).saturating_sub(trader_upnl).saturating_sub(pending_payouts)
}

/// Shares minted for `amount` USDC at NAV (+5 bps).
pub fn shares_for_deposit(amount: u64, nav: i64, supply: u64) -> MathResult<u64> {
    if amount == 0 {
        return Err(MathError::InvalidInput);
    }
    let net = amount as i128 - apply_bps_up(amount as i128, MINT_REDEEM_FEE_BPS)?;
    if supply == 0 {
        return to_u64(net);
    }
    if nav <= 0 {
        // a bucket with non-positive NAV is reduce-only
        return Err(MathError::InvalidInput);
    }
    to_u64(mul_div(net, supply as i128, nav as i128)?)
}

/// USDC paid for `shares` at NAV (−5 bps).
pub fn usdc_for_redeem(shares: u64, nav: i64, supply: u64) -> MathResult<u64> {
    if shares == 0 || supply == 0 || shares > supply {
        return Err(MathError::InvalidInput);
    }
    let gross = mul_div(shares as i128, nav.max(0) as i128, supply as i128)?;
    to_u64(gross - apply_bps_up(gross, MINT_REDEEM_FEE_BPS)?)
}

/// Utilization in bps: open notional reserved / bucket assets.
pub fn utilization_bps(reserved: i64, assets: i64) -> i64 {
    if assets <= 0 {
        return BPS;
    }
    ((reserved as i128 * BPS as i128) / assets as i128).clamp(0, BPS as i128 * 10) as i64
}

pub fn withdraw_is_instant(utilization_bps: i64) -> bool {
    utilization_bps < INSTANT_WITHDRAW_MAX_UTIL_BPS
}

/// Insurance target = 5% of the bucket's max OI.
pub fn insurance_target(max_oi: i64) -> MathResult<i64> {
    to_i64(apply_bps(max_oi as i128, 500)?)
}

/// Share of bucket fees routed to insurance: 20% below target, else 5%.
pub fn insurance_fee_share_bps(fund: i64, target: i64) -> i64 {
    if fund < target {
        2_000
    } else {
        500
    }
}

/// Bucket goes reduce-only when its insurance fund < 50% of target.
pub fn bucket_reduce_only(fund: i64, target: i64) -> bool {
    target > 0 && (fund as i128) * 2 < target as i128
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_redeem_round_trip_loses_only_fees() {
        let supply = 1_000_000 * USDC_SCALE as u64;
        let n = 1_100_000 * USDC_SCALE;
        let sh = shares_for_deposit(10_000 * USDC_SCALE as u64, n, supply).unwrap();
        let back = usdc_for_redeem(sh, n + 10_000 * USDC_SCALE, supply + sh).unwrap();
        assert!(back < 10_000 * USDC_SCALE as u64);
        assert!(back > 9_980 * USDC_SCALE as u64);
    }

    #[test]
    fn nav_and_queue() {
        assert_eq!(nav(100, 10, 30, 5), 75);
        assert!(withdraw_is_instant(4_999));
        assert!(!withdraw_is_instant(5_000));
    }

    #[test]
    fn insurance() {
        assert_eq!(insurance_target(10_000_000).unwrap(), 500_000);
        assert_eq!(insurance_fee_share_bps(1, 2), 2_000);
        assert!(bucket_reduce_only(49, 100));
        assert!(!bucket_reduce_only(50, 100));
    }
}
