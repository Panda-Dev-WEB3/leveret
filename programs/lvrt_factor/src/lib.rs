//! lvrt_factor — factor index registry (Backend §8).
//!
//! Scoring runs in the factor enclave (Python polars/numpy, published
//! methodology hash). Each publish is an Ed25519-signed receipt
//! `sign(level, methodology_hash, dataset_root, weights_root, snapshot_ts)`
//! verified here by instruction introspection; `dataset_root` is a Merkle
//! root over the per-name series. Factors trade as perps on lvrt_engine
//! (FACTORS bucket), priced through an lvrt_oracle feed whose only source is
//! the same enclave key. Methodology changes: propose → 30-day notice →
//! activate, all on-chain.

use anchor_lang::prelude::*;
use lvrt_common::{
    assert_upgrade_authority, ix_sysvar, seeds,
    sigverify::verified_messages,
    METHODOLOGY_NOTICE_S,
};

declare_id!("3JWHCTuGFfP84R6waHT1ojGCa27TeAVM6WQmsJzZjpx9");

/// Halt if attestation lapses for more than this many publish windows.
pub const MAX_MISSED_WINDOWS: u8 = 2;
pub const FACTOR_MSG_DOMAIN: [u8; 8] = *b"LVRTFX01";

#[error_code]
pub enum FactorError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Signer is neither authority nor guardian")]
    NotAuthorityOrGuardian,
    #[msg("No valid publisher signature in this transaction")]
    MissingSignature,
    #[msg("Receipt methodology hash does not match the active methodology")]
    WrongMethodology,
    #[msg("Snapshot is not newer than the last publish")]
    OutOfOrder,
    #[msg("Methodology notice period has not elapsed")]
    NoticePending,
    #[msg("No pending methodology change")]
    NothingPending,
    #[msg("Index is paused")]
    Paused,
    #[msg("Malformed receipt")]
    BadReceipt,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Cadence {
    Monthly,
    Quarterly,
    /// Semi-annual with a monthly ±20% drift check (TRND).
    SemiAnnualDrift,
}

#[account]
#[derive(InitSpace)]
pub struct FactorConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FactorIndex {
    /// e.g. "TRND", "STDY", "AIB", "QLTY".
    pub symbol: [u8; 8],
    /// Engine / oracle market id this index prices.
    pub market_id: u32,
    pub cadence: Cadence,
    /// Factor-enclave signing key (registered with attestation in lvrt_oracle).
    pub publisher: Pubkey,
    pub methodology_hash: [u8; 32],
    pub pending_methodology_hash: [u8; 32],
    pub pending_activates_at: i64,
    /// 1e8
    pub level: i64,
    pub dataset_root: [u8; 32],
    pub weights_root: [u8; 32],
    pub snapshot_ts: i64,
    pub publish_window_s: i64,
    pub paused: bool,
    pub bump: u8,
}

/// The signed receipt body.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct FactorReceipt {
    pub domain: [u8; 8],
    pub symbol: [u8; 8],
    pub level: i64,
    pub methodology_hash: [u8; 32],
    pub dataset_root: [u8; 32],
    pub weights_root: [u8; 32],
    pub snapshot_ts: i64,
}

#[event]
pub struct FactorPublished {
    pub symbol: [u8; 8],
    pub level: i64,
    pub methodology_hash: [u8; 32],
    pub dataset_root: [u8; 32],
    pub weights_root: [u8; 32],
    pub snapshot_ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct FactorParams {
    pub symbol: [u8; 8],
    pub market_id: u32,
    pub cadence: Cadence,
    pub publisher: Pubkey,
    pub methodology_hash: [u8; 32],
    pub publish_window_s: i64,
}

#[program]
pub mod lvrt_factor {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.guardian = guardian;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_factor(ctx: Context<CreateFactor>, params: FactorParams) -> Result<()> {
        let f = &mut ctx.accounts.factor;
        f.symbol = params.symbol;
        f.market_id = params.market_id;
        f.cadence = params.cadence;
        f.publisher = params.publisher;
        f.methodology_hash = params.methodology_hash;
        f.publish_window_s = params.publish_window_s;
        f.paused = true; // until the first publish
        f.bump = ctx.bumps.factor;
        Ok(())
    }

    /// Permissionless relay of an enclave-signed receipt.
    pub fn publish_level(ctx: Context<PublishLevel>) -> Result<()> {
        let f = &mut ctx.accounts.factor;
        let msgs = verified_messages(&ctx.accounts.instructions.to_account_info())?;
        let m = msgs.iter().find(|m| m.signer == f.publisher).ok_or(FactorError::MissingSignature)?;
        let r = FactorReceipt::try_from_slice(&m.message).map_err(|_| FactorError::BadReceipt)?;
        require!(r.domain == FACTOR_MSG_DOMAIN && r.symbol == f.symbol && r.level > 0, FactorError::BadReceipt);
        require!(r.methodology_hash == f.methodology_hash, FactorError::WrongMethodology);
        require!(r.snapshot_ts > f.snapshot_ts, FactorError::OutOfOrder);
        f.level = r.level;
        f.dataset_root = r.dataset_root;
        f.weights_root = r.weights_root;
        f.snapshot_ts = r.snapshot_ts;
        f.paused = false;
        emit!(FactorPublished {
            symbol: f.symbol,
            level: r.level,
            methodology_hash: r.methodology_hash,
            dataset_root: r.dataset_root,
            weights_root: r.weights_root,
            snapshot_ts: r.snapshot_ts,
        });
        Ok(())
    }

    /// Permissionless watchdog: pause when the enclave has missed more than
    /// two publish windows (attestation lapse).
    pub fn check_liveness(ctx: Context<Watch>) -> Result<()> {
        let f = &mut ctx.accounts.factor;
        let now = Clock::get()?.unix_timestamp;
        if f.snapshot_ts > 0 && now - f.snapshot_ts > f.publish_window_s * (MAX_MISSED_WINDOWS as i64 + 1) {
            f.paused = true;
        }
        Ok(())
    }

    pub fn propose_methodology(ctx: Context<AuthorityFactor>, new_hash: [u8; 32]) -> Result<()> {
        let f = &mut ctx.accounts.factor;
        f.pending_methodology_hash = new_hash;
        f.pending_activates_at = Clock::get()?.unix_timestamp + METHODOLOGY_NOTICE_S;
        Ok(())
    }

    /// Permissionless once the 30-day notice has elapsed.
    pub fn activate_methodology(ctx: Context<Watch>) -> Result<()> {
        let f = &mut ctx.accounts.factor;
        require!(f.pending_activates_at > 0, FactorError::NothingPending);
        require!(Clock::get()?.unix_timestamp >= f.pending_activates_at, FactorError::NoticePending);
        f.methodology_hash = f.pending_methodology_hash;
        f.pending_methodology_hash = [0; 32];
        f.pending_activates_at = 0;
        Ok(())
    }

    /// Key rotation (timelock).
    pub fn set_publisher(ctx: Context<AuthorityFactor>, publisher: Pubkey) -> Result<()> {
        ctx.accounts.factor.publisher = publisher;
        Ok(())
    }

    /// Guardian may pause; only the timelock unpauses (a fresh publish also
    /// unpauses, since it proves the enclave is live under the active hash).
    pub fn set_paused(ctx: Context<GuardianFactor>, paused: bool) -> Result<()> {
        let s = ctx.accounts.signer.key();
        let c = &ctx.accounts.config;
        if s != c.authority {
            require_keys_eq!(s, c.guardian, FactorError::NotAuthorityOrGuardian);
            require!(paused, FactorError::NotAuthorityOrGuardian);
        }
        ctx.accounts.factor.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + FactorConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, FactorConfig>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(params: FactorParams)]
pub struct CreateFactor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ FactorError::NotAuthority)]
    pub config: Account<'info, FactorConfig>,
    #[account(init, payer = payer, space = 8 + FactorIndex::INIT_SPACE, seeds = [seeds::FACTOR, &params.symbol], bump)]
    pub factor: Account<'info, FactorIndex>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishLevel<'info> {
    #[account(mut, seeds = [seeds::FACTOR, &factor.symbol], bump = factor.bump)]
    pub factor: Account<'info, FactorIndex>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Watch<'info> {
    #[account(mut, seeds = [seeds::FACTOR, &factor.symbol], bump = factor.bump)]
    pub factor: Account<'info, FactorIndex>,
}

#[derive(Accounts)]
pub struct AuthorityFactor<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ FactorError::NotAuthority)]
    pub config: Account<'info, FactorConfig>,
    #[account(mut, seeds = [seeds::FACTOR, &factor.symbol], bump = factor.bump)]
    pub factor: Account<'info, FactorIndex>,
}

#[derive(Accounts)]
pub struct GuardianFactor<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, FactorConfig>,
    #[account(mut, seeds = [seeds::FACTOR, &factor.symbol], bump = factor.bump)]
    pub factor: Account<'info, FactorIndex>,
}
