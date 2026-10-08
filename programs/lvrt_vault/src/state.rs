use anchor_lang::prelude::*;
use lvrt_common::Bucket;

#[account]
#[derive(InitSpace)]
pub struct VaultConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    /// lvrt_engine signer PDA: the only key that can settle PnL or report exposure.
    pub engine_signer: Pubkey,
    /// lvrt_insurance program: its per-bucket fund PDA pays slash recoveries.
    pub insurance_program: Pubkey,
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

/// One isolated LLP bucket per product family (§4). A bad night in Small Caps
/// can't touch Core.
#[account]
#[derive(InitSpace)]
pub struct BucketState {
    pub bucket: Bucket,
    /// Token-2022 LP share mint (no extensions).
    pub lp_mint: Pubkey,
    pub usdc_vault: Pubkey,
    /// Escrow for queued withdrawal shares.
    pub lp_escrow: Pubkey,
    /// USDC held (ledger mirror of `usdc_vault`).
    pub usdc_balance: u64,
    pub accrued_fees: u64,
    /// Trader uPnL against the bucket, marked at the oracle (reported by the engine).
    pub trader_upnl: i64,
    pub pending_payouts: u64,
    /// USDC owed to the bucket for slashed $LVRT not yet sold (counts in NAV,
    /// so the staked tranche absorbs bad debt before LPs do).
    pub slash_receivable: u64,
    /// Open notional the bucket is counterparty to.
    pub reserved_notional: u64,
    pub max_oi: u64,
    pub utilization_cap_bps: u16,
    pub queued_shares: u64,
    pub nav_ts: i64,
    pub bump: u8,
}

impl BucketState {
    pub fn nav(&self) -> i64 {
        lvrt_common::lvrt_math::vault::nav(self.usdc_balance as i64, self.accrued_fees as i64, self.trader_upnl, self.pending_payouts as i64)
            .saturating_add(self.slash_receivable as i64)
    }
    pub fn utilization_bps(&self) -> i64 {
        lvrt_common::lvrt_math::vault::utilization_bps(self.reserved_notional as i64, self.usdc_balance as i64)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Withdrawal {
    pub owner: Pubkey,
    pub bucket: Bucket,
    pub shares: u64,
    pub requested_at: i64,
    pub unlock_at: i64,
    pub nonce: u64,
    pub bump: u8,
}

#[event]
pub struct NavUpdated {
    pub bucket: Bucket,
    pub nav: i64,
    pub supply: u64,
    pub ts: i64,
}
