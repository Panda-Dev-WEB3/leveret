use anchor_lang::prelude::*;
use lvrt_common::{Family, PriceStatus, Session};

#[account]
#[derive(InitSpace)]
pub struct OracleConfig {
    /// lvrt_gov executor PDA.
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum SignerKind {
    /// Off-chain pusher relaying a verified upstream report (devnet/local, or
    /// a source whose on-chain verifier is not wired yet).
    Pusher,
    /// TEE enclave key (Small Caps, factor publisher), registered against an
    /// attestation hash and rotated every 24h.
    Enclave,
    /// Receipts service key for hourly Merkle roots.
    Receipts,
}

/// A key allowed to sign price messages for one source bit (§2.1, §6.1).
#[account]
#[derive(InitSpace)]
pub struct SignerKey {
    pub pubkey: Pubkey,
    pub kind: SignerKind,
    /// Source bit from `lvrt_math::oracle::source`.
    pub source: u8,
    pub attestation_hash: [u8; 32],
    pub tcb_level: u16,
    pub valid_until: i64,
    pub active: bool,
    pub bump: u8,
}

/// Timelocked per-market feed config.
#[account]
#[derive(InitSpace)]
pub struct Feed {
    pub market_id: u32,
    pub family: Family,
    pub symbol: [u8; 16],
    /// Source bits that may contribute.
    pub allowed_sources: u8,
    /// Sources needed for LIVE (Core ≥ 2).
    pub min_sources: u8,
    pub max_dev_bps: u16,
    pub fresh_ms: i64,
    /// Above this band the market goes WIDE (opens paused).
    pub band_limit_bps: u16,
    /// Normal band; the gap protocol enforces ≥ 2× this for 10 minutes.
    pub normal_band_bps: u16,
    pub chainlink_feed_id: [u8; 32],
    pub switchboard_feed_id: [u8; 32],
    /// Depth gate (the CarbonVote lesson): published depth of each source's
    /// underlying, recorded with the listing proposal.
    pub min_source_depth_usd: u64,
    pub bump: u8,
}

/// §2.2 — one PDA per market, written by the pusher or inline by a trade.
#[account]
#[derive(InitSpace)]
pub struct PriceState {
    pub market_id: u32,
    /// 1e8
    pub mid: i64,
    pub bid: i64,
    pub ask: i64,
    pub band_bps: u16,
    pub ts_ms: i64,
    pub slot: u64,
    pub session: Session,
    pub status: PriceStatus,
    pub source_mask: u8,
    /// Receipt leaf: hash of the accepted sample set.
    pub sample_hash: [u8; 32],
    /// Last regular-session price; used as the off-hours "last close".
    pub last_close: i64,
    /// Gap protocol end (ms) after a halt resumes.
    pub gap_until_ms: i64,
    /// Set when a halted/closed market prints its first fresh price
    /// (`at_open = true` checks for liquidations and knock-outs).
    pub at_open: bool,
    pub family: Family,
    pub bump: u8,
}

impl PriceState {
    pub fn is_fresh(&self, now_ms: i64, fresh_ms: i64) -> bool {
        now_ms - self.ts_ms <= fresh_ms
    }
}

pub const MAX_HOLIDAYS: usize = 64;

/// On-chain NYSE calendar used to cross-check the stream's market status.
#[account]
#[derive(InitSpace)]
pub struct Calendar {
    /// Days since the Unix epoch (UTC) on which US equities are closed.
    #[max_len(MAX_HOLIDAYS)]
    pub holidays: Vec<u32>,
    pub bump: u8,
}

impl Calendar {
    /// Weekend or listed holiday → CLOSED, regardless of the stream flag.
    pub fn forces_closed(&self, ts_ms: i64) -> bool {
        let day = ts_ms.div_euclid(86_400_000);
        let weekday = (day + 4).rem_euclid(7); // 0 = Sunday
        weekday == 0 || weekday == 6 || self.holidays.binary_search(&(day as u32)).is_ok()
    }
}

/// §11 — hourly Merkle root over fills, samples, liquidations, ADL events and
/// parameter activations.
#[account]
#[derive(InitSpace)]
pub struct ReceiptRoot {
    pub hour: u64,
    pub root: [u8; 32],
    pub leaf_count: u64,
    pub posted_by: Pubkey,
    pub bump: u8,
}

#[event]
pub struct PriceUpdated {
    pub market_id: u32,
    pub mid: i64,
    pub bid: i64,
    pub ask: i64,
    pub band_bps: u16,
    pub ts_ms: i64,
    pub status: PriceStatus,
    pub session: Session,
    pub source_mask: u8,
    pub sample_hash: [u8; 32],
}

#[event]
pub struct StatusChanged {
    pub market_id: u32,
    pub from: PriceStatus,
    pub to: PriceStatus,
    pub by: Pubkey,
}
