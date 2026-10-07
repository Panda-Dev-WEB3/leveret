//! Market-state sharding (§3.2).

use crate::fixed::*;

pub const DEFAULT_SHARDS: u8 = 8;
pub const MAX_SHARDS: u8 = 64;

/// `k = hash(margin_pubkey) mod S` using FNV-1a (cheap in CU, stable across
/// clients; contention spreading, not security).
pub fn shard_for(margin_pubkey: &[u8; 32], shards: u8) -> u8 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in margin_pubkey {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    (h % shards.max(1) as u64) as u8
}

/// Conservative OI bound used by a trade between merges:
/// `aggregated_oi + shard_delta_since_merge × S`.
pub fn oi_upper_bound(aggregated_oi: i64, shard_delta_since_merge: i64, shards: u8) -> MathResult<i64> {
    let d = (shard_delta_since_merge.max(0) as i128) * shards as i128;
    to_i64(aggregated_oi as i128 + d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spreads_across_shards() {
        let mut hits = [0u32; 8];
        for i in 0..800u32 {
            let mut k = [0u8; 32];
            k[..4].copy_from_slice(&i.to_le_bytes());
            hits[shard_for(&k, 8) as usize] += 1;
        }
        assert!(hits.iter().all(|h| *h > 50), "{hits:?}");
    }

    #[test]
    fn bound() {
        assert_eq!(oi_upper_bound(1_000, 10, 8).unwrap(), 1_080);
        assert_eq!(oi_upper_bound(1_000, -10, 8).unwrap(), 1_000);
    }
}
