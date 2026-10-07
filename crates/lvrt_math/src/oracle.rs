//! Multi-source price aggregation (Backend §2.3).

use crate::fixed::*;

pub const MAX_SOURCES: usize = 8;

/// Default max deviation of a source from the median before it is dropped.
pub const DEFAULT_MAX_DEV_BPS: i64 = 50;

/// Freshness windows (§2.3).
pub const FRESH_CORE_MS: i64 = 800;
pub const FRESH_STOCKS_MS: i64 = 2_000;
pub const FRESH_SMALLCAP_LISTED_MS: i64 = 5_000;
pub const FRESH_SMALLCAP_OTC_MS: i64 = 60_000;

/// Source bit positions in `PriceState.source_mask`.
pub mod source {
    pub const CHAINLINK: u8 = 0;
    pub const SWITCHBOARD: u8 = 1;
    pub const ENCLAVE: u8 = 2;
    pub const PYTH_PRO: u8 = 3;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sample {
    /// Bit index from [`source`].
    pub source: u8,
    pub mid: i64,
    pub bid: i64,
    pub ask: i64,
    pub ts_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggState {
    /// Enough agreeing fresh sources: opens and closes allowed.
    Live,
    /// Too few agreeing sources: opens paused, closes at the remaining price
    /// with a widened spread.
    Wide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Aggregate {
    pub mid: i64,
    pub bid: i64,
    pub ask: i64,
    pub band_bps: u16,
    pub source_mask: u8,
    pub state: AggState,
    /// Newest timestamp among the sources that were kept.
    pub ts_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OracleError {
    NoFreshSource,
    TooManySources,
    BadQuote,
}

/// Median of a small slice, averaging the two middle values for even lengths.
pub fn median(values: &[i64]) -> Option<i64> {
    let n = values.len();
    if n == 0 || n > MAX_SOURCES {
        return None;
    }
    let mut buf = [0i64; MAX_SOURCES];
    buf[..n].copy_from_slice(values);
    let s = &mut buf[..n];
    // insertion sort: n <= 8
    for i in 1..n {
        let mut j = i;
        while j > 0 && s[j - 1] > s[j] {
            s.swap(j - 1, j);
            j -= 1;
        }
    }
    if n % 2 == 1 {
        Some(s[n / 2])
    } else {
        Some(((s[n / 2 - 1] as i128 + s[n / 2] as i128) / 2) as i64)
    }
}

/// |a - b| / b in bps, saturating at u16::MAX.
pub fn deviation_bps(a: i64, b: i64) -> u16 {
    if b <= 0 {
        return u16::MAX;
    }
    let d = ((a as i128 - b as i128).abs() * BPS as i128) / b as i128;
    d.min(u16::MAX as i128) as u16
}

fn half_spread_bps(bid: i64, ask: i64, mid: i64) -> u16 {
    if mid <= 0 || ask < bid {
        return u16::MAX;
    }
    let d = ((ask as i128 - bid as i128) * BPS as i128) / (2 * mid as i128);
    d.min(u16::MAX as i128) as u16
}

fn validate(s: &Sample) -> Result<(), OracleError> {
    if s.mid <= 0 || s.bid <= 0 || s.ask <= 0 || s.bid > s.ask {
        return Err(OracleError::BadQuote);
    }
    Ok(())
}

/// Core markets: median of fresh sources, outliers beyond `max_dev_bps`
/// dropped, at least `min_sources` must survive for `Live`.
pub fn aggregate_median(
    samples: &[Sample],
    now_ms: i64,
    max_age_ms: i64,
    max_dev_bps: i64,
    min_sources: usize,
) -> Result<Aggregate, OracleError> {
    if samples.len() > MAX_SOURCES {
        return Err(OracleError::TooManySources);
    }
    let mut fresh = [Sample { source: 0, mid: 0, bid: 0, ask: 0, ts_ms: 0 }; MAX_SOURCES];
    let mut n = 0;
    for s in samples {
        validate(s)?;
        // reject stale and future-dated samples
        if now_ms - s.ts_ms <= max_age_ms && s.ts_ms <= now_ms + max_age_ms {
            fresh[n] = *s;
            n += 1;
        }
    }
    if n == 0 {
        return Err(OracleError::NoFreshSource);
    }
    let mut mids = [0i64; MAX_SOURCES];
    for i in 0..n {
        mids[i] = fresh[i].mid;
    }
    let m0 = median(&mids[..n]).ok_or(OracleError::NoFreshSource)?;

    let mut kept = [Sample { source: 0, mid: 0, bid: 0, ask: 0, ts_ms: 0 }; MAX_SOURCES];
    let mut k = 0;
    for s in &fresh[..n] {
        if deviation_bps(s.mid, m0) as i64 <= max_dev_bps {
            kept[k] = *s;
            k += 1;
        }
    }
    if k == 0 {
        // every source disagrees with the median of the set (only possible
        // with an even count split down the middle); fall back to the
        // freshest sample, flagged Wide.
        let newest = fresh[..n].iter().max_by_key(|s| s.ts_ms).copied().ok_or(OracleError::NoFreshSource)?;
        kept[0] = newest;
        k = 1;
    }

    let (mut ms, mut bs, mut as_) = ([0i64; MAX_SOURCES], [0i64; MAX_SOURCES], [0i64; MAX_SOURCES]);
    let mut mask = 0u8;
    let mut ts = i64::MIN;
    for i in 0..k {
        ms[i] = kept[i].mid;
        bs[i] = kept[i].bid;
        as_[i] = kept[i].ask;
        mask |= 1 << kept[i].source;
        ts = ts.max(kept[i].ts_ms);
    }
    let mid = median(&ms[..k]).ok_or(OracleError::NoFreshSource)?;
    let bid = median(&bs[..k]).ok_or(OracleError::NoFreshSource)?.min(mid);
    let ask = median(&as_[..k]).ok_or(OracleError::NoFreshSource)?.max(mid);

    let mut dispersion = 0u16;
    for i in 0..k {
        dispersion = dispersion.max(deviation_bps(ms[i], mid));
    }
    let band_bps = dispersion.max(half_spread_bps(bid, ask, mid));
    let state = if k >= min_sources { AggState::Live } else { AggState::Wide };
    Ok(Aggregate { mid, bid, ask, band_bps, source_mask: mask, state, ts_ms: ts })
}

/// Stocks: the primary (Chainlink) bid/ask is used as-is; a secondary source
/// must be fresh and agree within `max_dev_bps`, otherwise the market is Wide.
pub fn aggregate_primary_confirmed(
    primary: &Sample,
    secondary: Option<&Sample>,
    now_ms: i64,
    max_age_ms: i64,
    max_dev_bps: i64,
) -> Result<Aggregate, OracleError> {
    validate(primary)?;
    if now_ms - primary.ts_ms > max_age_ms {
        return Err(OracleError::NoFreshSource);
    }
    let mut mask = 1u8 << primary.source;
    let mut state = AggState::Wide;
    let mut band = half_spread_bps(primary.bid, primary.ask, primary.mid);
    if let Some(s) = secondary {
        validate(s)?;
        let dev = deviation_bps(s.mid, primary.mid);
        if now_ms - s.ts_ms <= max_age_ms && dev as i64 <= max_dev_bps {
            mask |= 1 << s.source;
            state = AggState::Live;
            band = band.max(dev);
        }
    }
    Ok(Aggregate {
        mid: primary.mid,
        bid: primary.bid,
        ask: primary.ask,
        band_bps: band,
        source_mask: mask,
        state,
        ts_ms: primary.ts_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(source: u8, mid: i64, ts_ms: i64) -> Sample {
        Sample { source, mid, bid: mid - 1_000, ask: mid + 1_000, ts_ms }
    }

    const P: i64 = 150 * PRICE_SCALE;

    #[test]
    fn median_odd_even() {
        assert_eq!(median(&[3, 1, 2]), Some(2));
        assert_eq!(median(&[4, 1, 3, 2]), Some(2));
        assert_eq!(median(&[]), None);
    }

    #[test]
    fn two_agreeing_sources_are_live() {
        let a = aggregate_median(&[s(0, P, 1_000), s(1, P + P / 1000, 1_000)], 1_500, 800, 50, 2).unwrap();
        assert_eq!(a.state, AggState::Live);
        assert_eq!(a.source_mask, 0b11);
    }

    #[test]
    fn outlier_is_dropped_and_market_goes_wide() {
        // second source 2% away: dropped → single source → WIDE (opens paused)
        let a = aggregate_median(&[s(0, P, 1_000), s(1, P + P / 50, 1_000), s(2, P + 10, 1_000)], 1_000, 800, 50, 2).unwrap();
        assert_eq!(a.state, AggState::Live);
        assert_eq!(a.source_mask, 0b101);
        let w = aggregate_median(&[s(0, P, 1_000), s(1, P + P / 50, 0)], 1_000, 800, 50, 2).unwrap();
        // source 1 is stale (1000ms old > 800ms)
        assert_eq!(w.state, AggState::Wide);
        assert_eq!(w.source_mask, 0b1);
    }

    #[test]
    fn stale_everything_errors() {
        assert_eq!(aggregate_median(&[s(0, P, 0)], 10_000, 800, 50, 2), Err(OracleError::NoFreshSource));
    }

    #[test]
    fn stocks_need_confirmation() {
        let p = s(source::CHAINLINK, P, 1_000);
        let ok = aggregate_primary_confirmed(&p, Some(&s(source::PYTH_PRO, P + P / 10_000, 900)), 1_000, 2_000, 50).unwrap();
        assert_eq!(ok.state, AggState::Live);
        let wide = aggregate_primary_confirmed(&p, None, 1_000, 2_000, 50).unwrap();
        assert_eq!(wide.state, AggState::Wide);
    }

    #[test]
    fn bad_quote_rejected() {
        let mut bad = s(0, P, 0);
        bad.bid = bad.ask + 1;
        assert_eq!(aggregate_median(&[bad], 0, 800, 50, 1), Err(OracleError::BadQuote));
    }
}
