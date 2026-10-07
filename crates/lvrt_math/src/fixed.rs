//! Scales, the shared error type and checked fixed-point helpers.

pub const PRICE_SCALE: i64 = 100_000_000;
pub const USDC_SCALE: i64 = 1_000_000;
pub const BASE_SCALE: i64 = 1_000_000;
pub const BPS: i64 = 10_000;
pub const RATE_SCALE: i128 = 1_000_000_000_000;
pub const NORM_SCALE: i128 = 1_000_000_000_000_000_000;
pub const SECONDS_PER_DAY: i64 = 86_400;
pub const MS_PER_SECOND: i64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError {
    Overflow,
    DivideByZero,
    InvalidInput,
}

pub type MathResult<T> = Result<T, MathError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

impl Side {
    /// +1 for long, -1 for short.
    pub const fn sign(self) -> i64 {
        match self {
            Side::Long => 1,
            Side::Short => -1,
        }
    }
}

/// `a * b / d` in i128 with overflow and zero checks, rounding toward zero.
pub fn mul_div(a: i128, b: i128, d: i128) -> MathResult<i128> {
    if d == 0 {
        return Err(MathError::DivideByZero);
    }
    a.checked_mul(b).ok_or(MathError::Overflow)?.checked_div(d).ok_or(MathError::Overflow)
}

/// `a * b / d` rounding away from zero (used where the protocol must not
/// under-charge, e.g. fees and margin requirements).
pub fn mul_div_up(a: i128, b: i128, d: i128) -> MathResult<i128> {
    if d == 0 {
        return Err(MathError::DivideByZero);
    }
    let n = a.checked_mul(b).ok_or(MathError::Overflow)?;
    let q = n / d;
    if n % d != 0 && ((n > 0) == (d > 0)) {
        Ok(q + 1)
    } else if n % d != 0 {
        Ok(q - 1)
    } else {
        Ok(q)
    }
}

pub fn to_i64(v: i128) -> MathResult<i64> {
    i64::try_from(v).map_err(|_| MathError::Overflow)
}

pub fn to_u64(v: i128) -> MathResult<u64> {
    u64::try_from(v).map_err(|_| MathError::Overflow)
}

/// Apply `bps` to `v`: `v * bps / 10_000`.
pub fn apply_bps(v: i128, bps: i64) -> MathResult<i128> {
    mul_div(v, bps as i128, BPS as i128)
}

pub fn apply_bps_up(v: i128, bps: i64) -> MathResult<i128> {
    mul_div_up(v, bps as i128, BPS as i128)
}

/// Notional in USDC (1e6) of `size` base units (1e6) at `price` (1e8).
/// Sign follows `size`.
pub fn notional(size: i64, price: i64) -> MathResult<i64> {
    to_i64(mul_div(size as i128, price as i128, PRICE_SCALE as i128)?)
}

pub fn clamp_i128(v: i128, lo: i128, hi: i128) -> i128 {
    if v < lo {
        lo
    } else if v > hi {
        hi
    } else {
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notional_units() {
        // 2 NVDA at $180.50 = $361.00
        assert_eq!(notional(2 * BASE_SCALE, 18_050_000_000).unwrap(), 361 * USDC_SCALE);
        assert_eq!(notional(-2 * BASE_SCALE, 18_050_000_000).unwrap(), -361 * USDC_SCALE);
    }

    #[test]
    fn rounding_up() {
        assert_eq!(mul_div_up(10, 1, 3).unwrap(), 4);
        assert_eq!(mul_div_up(-10, 1, 3).unwrap(), -4);
        assert_eq!(mul_div_up(9, 1, 3).unwrap(), 3);
        assert_eq!(mul_div(10, 1, 0), Err(MathError::DivideByZero));
    }
}
