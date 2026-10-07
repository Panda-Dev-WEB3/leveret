use anchor_lang::prelude::*;

/// Proposals may only be executed within this window after their ETA.
pub const GRACE_PERIOD_S: i64 = 14 * 86_400;
pub const MAX_PROPOSAL_ACCOUNTS: usize = 24;
pub const MAX_PROPOSAL_DATA: usize = 512;

#[account]
#[derive(InitSpace)]
pub struct GovConfig {
    /// Squads v4 vault PDA (3-of-5, hardware keys).
    pub admin: Pubkey,
    /// Guardian multisig (2-of-3): cancel + tighten only.
    pub guardian: Pubkey,
    pub delay_s: i64,
    pub proposal_count: u64,
    pub executor_bump: u8,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub struct ProposalAccountMeta {
    pub pubkey: Pubkey,
    pub is_signer: bool,
    pub is_writable: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ProposalStatus {
    Queued,
    Executed,
    Cancelled,
}

#[account]
pub struct Proposal {
    pub id: u64,
    pub proposer: Pubkey,
    pub target_program: Pubkey,
    pub accounts: Vec<ProposalAccountMeta>,
    pub data: Vec<u8>,
    /// Hash of the human-readable proposal (published off-chain).
    pub description_hash: [u8; 32],
    pub queued_at: i64,
    pub eta: i64,
    pub status: ProposalStatus,
    pub bump: u8,
}

impl Proposal {
    pub fn space(n_accounts: usize, data_len: usize) -> usize {
        8 + 8 + 32 + 32 + 4 + n_accounts * ProposalAccountMeta::INIT_SPACE + 4 + data_len + 32 + 8 + 8 + 1 + 1
    }
}

/// Emitted for the receipts service (parameter activations are receipt leaves).
#[event]
pub struct ProposalQueued {
    pub id: u64,
    pub target_program: Pubkey,
    pub eta: i64,
    pub description_hash: [u8; 32],
}

#[event]
pub struct ProposalExecuted {
    pub id: u64,
    pub target_program: Pubkey,
    pub executed_at: i64,
}

#[event]
pub struct ProposalCancelled {
    pub id: u64,
    pub by: Pubkey,
}
