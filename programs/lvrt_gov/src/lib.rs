//! lvrt_gov — Squads 3-of-5 → queue → 72h → execute (Backend §12).
//!
//! Every Leveret program stores this program's executor PDA as its
//! `authority`. A queued proposal is an arbitrary instruction; on execution
//! the executor PDA signs it via `invoke_signed`. The guardian (2-of-3) can
//! cancel proposals and call tighten-only setters on target programs
//! directly, but can never loosen anything.

use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use instructions::*;
pub use state::*;

declare_id!("2CvejCR36zZzmKgtBBP6G9jpVQCwwZ1AUe355t1Bci2E");

#[program]
pub mod lvrt_gov {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey, guardian: Pubkey, delay_s: i64) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, admin, guardian, delay_s)
    }

    pub fn queue(
        ctx: Context<Queue>,
        target_program: Pubkey,
        accounts: Vec<ProposalAccountMeta>,
        data: Vec<u8>,
        description_hash: [u8; 32],
    ) -> Result<()> {
        instructions::queue::handle_queue(ctx, target_program, accounts, data, description_hash)
    }

    pub fn cancel(ctx: Context<Cancel>) -> Result<()> {
        instructions::cancel::handle_cancel(ctx)
    }

    pub fn execute<'info>(ctx: Context<'info, Execute<'info>>) -> Result<()> {
        instructions::execute::handle_execute(ctx)
    }

    /// Self-administration: callable only by the executor, i.e. through the timelock.
    pub fn set_roles(ctx: Context<SetRoles>, admin: Pubkey, guardian: Pubkey, delay_s: i64) -> Result<()> {
        instructions::set_roles::handle_set_roles(ctx, admin, guardian, delay_s)
    }
}
