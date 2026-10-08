//! Leveret fixed-point math.
//!
//! Everything here is pure integer arithmetic so the same code runs inside the
//! on-chain programs (SBF), the keepers and the test harness and produces
//! bit-identical results.
//!
//! Units used throughout:
//! - prices: `i64` scaled by [`PRICE_SCALE`] (1e8)
//! - USDC amounts: `i64`/`u64` scaled by [`USDC_SCALE`] (1e6)
//! - position sizes: `i64` base units scaled by [`BASE_SCALE`] (1e6), signed
//!   where a direction matters (long > 0)
//! - basis points: `u16`/`i64`, 1 bp = 1 / [`BPS`]
//! - funding / financing rates: fraction per day scaled by [`RATE_SCALE`] (1e12)
//! - power `norm_factor`: scaled by [`NORM_SCALE`] (1e18)

#![cfg_attr(not(test), no_std)]

pub mod adl;
pub mod corporate;
pub mod factor;
pub mod fees;
pub mod fixed;
pub mod funding;
pub mod margin;
pub mod oracle;
pub mod power;
pub mod pricing;
pub mod risk;
pub mod shard;
pub mod tickets;
pub mod tranche;
pub mod vault;

pub use fixed::*;
