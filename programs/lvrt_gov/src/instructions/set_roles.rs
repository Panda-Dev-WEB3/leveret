use anchor_lang::prelude::*;
use lvrt_common::{seeds, TIMELOCK_DELAY_S};

use crate::{error::GovError, state::GovConfig};

#[derive(Accounts)]
pub struct SetRoles<'info> {
    #[account(seeds = [seeds::EXECUTOR], bump = config.executor_bump)]
    pub executor: Signer<'info>,
    #[account(mut, seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, GovConfig>,
}

pub fn handle_set_roles(ctx: Context<SetRoles>, admin: Pubkey, guardian: Pubkey, delay_s: i64) -> Result<()> {
    require!(delay_s >= TIMELOCK_DELAY_S, GovError::DelayTooShort);
    let c = &mut ctx.accounts.config;
    c.admin = admin;
    c.guardian = guardian;
    c.delay_s = delay_s;
    Ok(())
}
