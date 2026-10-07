use anchor_lang::prelude::*;
use lvrt_common::seeds;

use crate::{
    error::GovError,
    state::{GovConfig, Proposal, ProposalCancelled, ProposalStatus},
};

#[derive(Accounts)]
pub struct Cancel<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, GovConfig>,
    #[account(mut, seeds = [seeds::PROPOSAL, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,
}

pub fn handle_cancel(ctx: Context<Cancel>) -> Result<()> {
    let s = ctx.accounts.signer.key();
    let c = &ctx.accounts.config;
    require!(s == c.admin || s == c.guardian, GovError::NotAdminOrGuardian);
    let p = &mut ctx.accounts.proposal;
    require!(p.status == ProposalStatus::Queued, GovError::NotPending);
    p.status = ProposalStatus::Cancelled;
    emit!(ProposalCancelled { id: p.id, by: s });
    Ok(())
}
