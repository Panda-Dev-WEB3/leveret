use anchor_lang::prelude::*;
use lvrt_common::{assert_upgrade_authority, seeds, TIMELOCK_DELAY_S};

use crate::{error::GovError, state::GovConfig};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + GovConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, GovConfig>,
    /// CHECK: executor PDA, only its bump is recorded.
    #[account(seeds = [seeds::EXECUTOR], bump)]
    pub executor: UncheckedAccount<'info>,
    /// CHECK: this program's account, used for the upgrade-authority check.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: verified against `program` in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, admin: Pubkey, guardian: Pubkey, delay_s: i64) -> Result<()> {
    assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())
        .map_err(|_| error!(GovError::NotUpgradeAuthority))?;
    require!(delay_s >= TIMELOCK_DELAY_S, GovError::DelayTooShort);
    let c = &mut ctx.accounts.config;
    c.admin = admin;
    c.guardian = guardian;
    c.delay_s = delay_s;
    c.proposal_count = 0;
    c.executor_bump = ctx.bumps.executor;
    c.bump = ctx.bumps.config;
    Ok(())
}
