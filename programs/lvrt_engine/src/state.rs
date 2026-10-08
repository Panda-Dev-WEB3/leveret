use anchor_lang::prelude::*;
use lvrt_common::{Bucket, Family, Side};

pub const MAX_DELEGATES: usize = 4;
pub const MAX_CUSTODY: u8 = 16;
pub const MAX_POSITIONS_PER_ACCOUNT: u16 = 16;

#[account]
#[derive(InitSpace)]
pub struct EngineConfig {
    /// lvrt_gov executor PDA.
    pub authority: Pubkey,
    pub guardian: Pubkey,
    /// ca-calendar operator: may only *declare* corporate actions (which
    /// freeze a market); it can't change risk.
    pub ca_operator: Pubkey,
    pub usdc_mint: Pubkey,
    pub custody_count: u8,
    /// Pause blocks entries only (design rule 3).
    pub opens_paused: bool,
    /// May run ADL (default unset = disabled). Selection is checked on-chain
    /// for ordering and logged; see `auto_deleverage`.
    pub adl_operator: Pubkey,
    /// ADL may start when trader uPnL ≥ this share of bucket capital…
    pub adl_trigger_bps: u16,
    /// …and each step closes just enough to come back to this share.
    pub adl_target_bps: u16,
    pub signer_bump: u8,
    pub bump: u8,
}

/// Engine-side state per LLP bucket.
#[account]
#[derive(InitSpace)]
pub struct BucketRisk {
    pub bucket: Bucket,
    /// Markets counterparty to this bucket; ADL must see all of them.
    pub market_count: u16,
    pub adl_active: bool,
    pub adl_round: u32,
    /// Ranks within a round must be non-increasing.
    pub adl_last_rank: i128,
    pub adl_last_ts: i64,
    pub bump: u8,
}

/// Risk parameters: functions of liquidity class and band, set only through
/// the timelock (guardian can tighten).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct RiskParams {
    pub max_lev_x100: u32,
    /// 0 = no off-hours opens.
    pub off_hours_lev_x100: u32,
    pub mm_bps: u16,
    pub mm_off_hours_bps: u16,
    /// OI caps in base units (1e6).
    pub oi_cap_long: u64,
    pub oi_cap_short: u64,
    /// Per-account position cap in USDC notional.
    pub max_position_notional: u64,
    pub base_spread_bps: u16,
    pub off_hours_spread_bps: u16,
    /// Extra spread on WIDE closes (only the remaining source is trusted).
    pub wide_spread_bps: u16,
    pub k_band_bps: u16,
    pub max_premium_bps: u16,
    pub skew_scale: u64,
    /// Full leverage up to this band, scaled to 1× at `band_limit_bps`.
    pub band_ref_bps: u16,
    pub band_limit_bps: u16,
    /// Taker fee in tenths of a bp before holding-tier discounts.
    pub fee_tenth_bps: u16,
    pub liq_bounty_cap: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct FundingConfig {
    /// RATE_SCALE units per day per day.
    pub max_velocity: u64,
    pub max_rate: u64,
    /// Small Caps: k · (OI_long − OI_short) / OI_total.
    pub imbalance_k: i64,
    /// Borrow, ppm of notional per hour: base + slope · utilization.
    pub borrow_base_ppm: u32,
    pub borrow_slope_ppm: u32,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum CaKind {
    None,
    Split,
    Dividend,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct CorporateAction {
    /// Positions with `ca_epoch < epoch` must be rescaled before trading.
    pub epoch: u32,
    pub kind: CaKind,
    pub ratio_num: u32,
    pub ratio_den: u32,
    /// Dividend per share, 1e8.
    pub dividend: i64,
    pub effective_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub market_id: u32,
    pub family: Family,
    pub bucket: Bucket,
    /// lvrt_oracle PriceState for this market.
    pub price_state: Pubkey,
    pub fresh_ms: i64,
    pub risk: RiskParams,
    pub funding: FundingConfig,
    pub shards: u8,
    pub reduce_only: bool,
    /// New markets start guarded (half caps) and graduate after 30 days.
    pub guarded: bool,
    pub listed_at: i64,
    pub ca: CorporateAction,
    pub bump: u8,
}

/// Aggregated view written by the merge cranker every slot.
#[account]
#[derive(InitSpace)]
pub struct FundingState {
    pub market_id: u32,
    /// RATE_SCALE units per day; positive = longs pay.
    pub rate: i128,
    /// Σ rate·dt·mid, PRICE_SCALE·FUNDING_PRECISION units.
    pub index: i128,
    /// Σ borrow ppm·1e6 per unit notional.
    pub borrow_index: i128,
    pub last_update: i64,
    pub oi_long: u64,
    pub oi_short: u64,
    pub long_entry_notional: u64,
    pub short_entry_notional: u64,
    /// Σ over shards of `−trader_pnl + carry − bad_debt` not yet settled
    /// (positive = owed to the bucket). Written by merge, reduced by settle.
    pub unsettled_to_bucket: i64,
    pub last_merge_slot: u64,
    pub bump: u8,
}

impl FundingState {
    pub fn skew(&self) -> i64 {
        self.oi_long as i64 - self.oi_short as i64
    }
}

/// §3.2 — trades write only their own shard.
#[account]
#[derive(InitSpace)]
pub struct MarketShard {
    pub market_id: u32,
    pub index: u8,
    pub oi_long: u64,
    pub oi_short: u64,
    pub long_entry_notional: u64,
    pub short_entry_notional: u64,
    /// Fees owed to the bucket / fee router, not yet settled.
    pub fees_accrued: u64,
    /// Σ realized trader PnL (positive = traders won) not yet settled.
    pub trader_pnl_unsettled: i64,
    /// Shortfall beyond position margin, for the loss waterfall.
    pub bad_debt: u64,
    /// Σ funding + borrow taken from (positive) or paid to (negative) trader
    /// ledgers. Funding nets to zero only when OI is balanced; the pool is
    /// counterparty to the skew and earns all borrow.
    pub carry_unsettled: i64,
    /// This shard's `−pnl + carry − bad_debt` as counted in
    /// `FundingState.unsettled_to_bucket` at the last merge.
    pub merged_to_bucket: i64,
    /// OI added since the last merge (base units, gross).
    pub delta_long_since_merge: u64,
    pub delta_short_since_merge: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace, Default)]
pub struct Delegate {
    pub signer: Pubkey,
    /// bits: 0 core, 1 stocks, 2 smallcap, 3 squared, 4 factors, 5 tickets,
    /// 6 twins, 7 withdraw (never set by default).
    pub tool_mask: u8,
    pub max_per_order: u64,
    pub daily_budget: u64,
    pub spent_today: u64,
    pub day: u32,
    pub expiry: i64,
}

pub mod tool {
    pub const WITHDRAW: u8 = 7;
}

#[account]
#[derive(InitSpace)]
pub struct MarginAccount {
    pub owner: Pubkey,
    pub sub_id: u8,
    /// Internal USDC ledger (1e6). USDC only moves on deposit/withdraw.
    pub collateral: i64,
    /// Σ initial margin of open cross positions at entry.
    pub im_reserved: u64,
    pub open_positions: u16,
    /// $LVRT holding tier, written by the fee router's tier crank.
    pub fee_tier: u8,
    pub delegates: [Delegate; MAX_DELEGATES],
    /// Circuit breaker window.
    pub cb_window_start: i64,
    pub cb_paid: i64,
    pub queued_profit: u64,
    pub queued_release_ts: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub margin: Pubkey,
    pub market_id: u32,
    pub side: Side,
    /// Base units (1e6).
    pub size: u64,
    pub entry_px: i64,
    pub entry_notional: u64,
    pub entry_funding_index: i128,
    pub entry_borrow_index: i128,
    /// 0 = cross margin.
    pub isolated_margin: u64,
    pub im_reserved: u64,
    pub opened_at: i64,
    /// Spread paid on the most recent open (anti-staleness edge).
    pub spread_paid: u64,
    pub ca_epoch: u32,
    pub shard: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum TriggerKind {
    TakeProfit,
    StopLoss,
}

#[account]
#[derive(InitSpace)]
pub struct Trigger {
    pub margin: Pubkey,
    pub owner: Pubkey,
    pub market_id: u32,
    /// Side of the position this trigger reduces.
    pub side: Side,
    pub kind: TriggerKind,
    pub trigger_px: i64,
    pub size: u64,
    pub expiry: i64,
    pub max_slippage_bps: u16,
    /// Fixed keeper bounty (USDC), shown when placed, paid by the owner.
    pub keeper_bounty: u64,
    pub nonce: u64,
    pub bump: u8,
}

#[event]
pub struct FillEvent {
    pub market_id: u32,
    pub margin: Pubkey,
    pub side: Side,
    pub is_open: bool,
    pub size: u64,
    pub price: i64,
    pub fee: u64,
    pub spread_paid: u64,
    pub realized_pnl: i64,
    pub sample_hash: [u8; 32],
    pub ts: i64,
}

#[event]
pub struct LiquidationEvent {
    pub market_id: u32,
    pub margin: Pubkey,
    pub liquidator: Pubkey,
    pub side: Side,
    pub size: u64,
    pub price: i64,
    pub bounty: u64,
    pub bad_debt: u64,
    pub sample_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AdlReason {
    /// Trader uPnL reached `adl_trigger_bps` of bucket capital.
    BucketPnlRatio,
}

#[event]
pub struct AdlEvent {
    pub market_id: u32,
    pub margin: Pubkey,
    pub side: Side,
    pub size: u64,
    pub price: i64,
    pub realized_pnl: i64,
    pub rank: i128,
    pub round: u32,
    pub ratio_before_bps: i64,
    pub ratio_after_bps: i64,
    pub reason: AdlReason,
}

#[event]
pub struct ShardSettled {
    pub market_id: u32,
    pub shard: u8,
    pub fees: u64,
    /// Positive: custody → bucket; negative: bucket → custody.
    pub to_bucket: i64,
    pub insurance_covered: u64,
    /// Bad debt left for the staked tranche / LLP NAV.
    pub uncovered: u64,
}

#[event]
pub struct FundingMerged {
    pub market_id: u32,
    pub rate: i128,
    pub index: i128,
    pub oi_long: u64,
    pub oi_short: u64,
    pub slot: u64,
}
