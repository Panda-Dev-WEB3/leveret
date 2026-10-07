//! Families, sessions and leverage limits as functions of liquidity class and
//! the live band (design rule 2).

use crate::fixed::*;
use crate::margin::LEV_SCALE;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Family {
    Core = 0,
    Stocks = 1,
    SmallCap = 2,
    Squared = 3,
    Factors = 4,
    Tickets = 5,
    Twins = 6,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Session {
    Regular = 0,
    Pre = 1,
    Post = 2,
    Overnight = 3,
    Closed = 4,
}

impl Session {
    pub fn is_off_hours(self) -> bool {
        !matches!(self, Session::Regular)
    }
}

/// Small-cap risk classes (§6.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum SmallCapClass {
    A = 0,
    B = 1,
    C = 2,
    D = 3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClassLimits {
    pub max_lev_x100: i64,
    /// OI cap as bps of ADV.
    pub oi_cap_adv_bps: i64,
    pub base_spread_bps: i64,
    /// 0 = closed off-hours.
    pub after_hours_lev_x100: i64,
    pub mm_bps: i64,
}

pub const fn small_cap_limits(c: SmallCapClass) -> ClassLimits {
    match c {
        SmallCapClass::A => ClassLimits { max_lev_x100: 1_000, oi_cap_adv_bps: 50, base_spread_bps: 10, after_hours_lev_x100: 300, mm_bps: 500 },
        SmallCapClass::B => ClassLimits { max_lev_x100: 500, oi_cap_adv_bps: 30, base_spread_bps: 25, after_hours_lev_x100: 200, mm_bps: 1_000 },
        SmallCapClass::C => ClassLimits { max_lev_x100: 300, oi_cap_adv_bps: 20, base_spread_bps: 50, after_hours_lev_x100: 150, mm_bps: 1_500 },
        SmallCapClass::D => ClassLimits { max_lev_x100: 200, oi_cap_adv_bps: 10, base_spread_bps: 100, after_hours_lev_x100: 0, mm_bps: 2_000 },
    }
}

/// Classify a listed small cap by ADV (USDC); OTC names are always D.
pub fn classify_small_cap(adv_usdc: i64, otc: bool) -> SmallCapClass {
    let m = 1_000_000 * USDC_SCALE;
    if otc {
        SmallCapClass::D
    } else if adv_usdc >= 50 * m {
        SmallCapClass::A
    } else if adv_usdc >= 5 * m {
        SmallCapClass::B
    } else {
        SmallCapClass::C
    }
}

/// Band-dependent leverage: full leverage up to `band_ref_bps`, then scaled
/// down linearly to 1× at `band_limit_bps`.
pub fn class_lev_for_band(max_lev_x100: i64, band_bps: u16, band_ref_bps: u16, band_limit_bps: u16) -> i64 {
    if band_bps <= band_ref_bps {
        return max_lev_x100;
    }
    if band_bps >= band_limit_bps || band_limit_bps <= band_ref_bps {
        return LEV_SCALE;
    }
    let span = (band_limit_bps - band_ref_bps) as i64;
    let over = (band_bps - band_ref_bps) as i64;
    (max_lev_x100 - (max_lev_x100 - LEV_SCALE) * over / span).max(LEV_SCALE)
}

/// Whether a family may open in a session. Closes are always allowed
/// (design rule 3); this only gates entries.
pub fn opens_allowed(family: Family, session: Session, after_hours_lev_x100: i64) -> bool {
    match family {
        Family::Core => true,
        _ => match session {
            Session::Regular => true,
            Session::Closed => false,
            _ => after_hours_lev_x100 > 0,
        },
    }
}

/// Effective max leverage: min(market, class(band), session).
pub fn effective_max_lev(market_max: i64, class_lev: i64, session: Session, off_hours_lev: i64) -> i64 {
    let session_lev = if session.is_off_hours() { off_hours_lev } else { i64::MAX };
    market_max.min(class_lev).min(session_lev)
}

/// Guarded markets run at half caps until graduation.
pub fn guarded_cap(cap: i64, guarded: bool) -> i64 {
    if guarded {
        cap / 2
    } else {
        cap
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes() {
        let m = 1_000_000 * USDC_SCALE;
        assert_eq!(classify_small_cap(60 * m, false), SmallCapClass::A);
        assert_eq!(classify_small_cap(6 * m, false), SmallCapClass::B);
        assert_eq!(classify_small_cap(2 * m, false), SmallCapClass::C);
        assert_eq!(classify_small_cap(600 * m, true), SmallCapClass::D);
        assert_eq!(small_cap_limits(SmallCapClass::D).after_hours_lev_x100, 0);
    }

    #[test]
    fn band_scaling() {
        assert_eq!(class_lev_for_band(1_000, 10, 50, 250), 1_000);
        assert_eq!(class_lev_for_band(1_000, 150, 50, 250), 550);
        assert_eq!(class_lev_for_band(1_000, 300, 50, 250), 100);
    }

    #[test]
    fn sessions() {
        assert!(!opens_allowed(Family::Stocks, Session::Closed, 300));
        assert!(opens_allowed(Family::Stocks, Session::Overnight, 300));
        assert!(!opens_allowed(Family::SmallCap, Session::Post, 0));
        assert!(opens_allowed(Family::Core, Session::Closed, 0));
        assert_eq!(effective_max_lev(2_000, 1_500, Session::Pre, 500), 500);
        assert_eq!(effective_max_lev(2_000, 1_500, Session::Regular, 500), 1_500);
    }
}
