use anchor_lang::prelude::*;
use lvrt_common::seeds;

use crate::{
    error::GovError,
    state::{GovConfig, Proposal, ProposalAccountMeta, ProposalQueued, ProposalStatus, MAX_PROPOSAL_ACCOUNTS, MAX_PROPOSAL_DATA},
};

#[derive(Accounts)]
#[instruction(target_program: Pubkey, accounts: Vec<ProposalAccountMeta>, data: Vec<u8>)]
pub struct Queue<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [seeds::CONFIG], bump = config.bump, has_one = admin @ GovError::NotAdmin)]
    pub config: Account<'info, GovConfig>,
    #[account(
        init,
        payer = admin,
        space = Proposal::space(accounts.len(), data.len()),
        seeds = [seeds::PROPOSAL, &config.proposal_count.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

pub fn handle_queue(
    ctx: Context<Queue>,
    target_program: Pubkey,
    accounts: Vec<ProposalAccountMeta>,
    data: Vec<u8>,
    description_hash: [u8; 32],
) -> Result<()> {
    require!(accounts.len() <= MAX_PROPOSAL_ACCOUNTS && data.len() <= MAX_PROPOSAL_DATA, GovError::PayloadTooLarge);
    let now = Clock::get()?.unix_timestamp;
    let cfg = &mut ctx.accounts.config;
    let p = &mut ctx.accounts.proposal;
    p.id = cfg.proposal_count;
    p.proposer = ctx.accounts.admin.key();
    p.target_program = target_program;
    p.accounts = accounts;
    p.data = data;
    p.description_hash = description_hash;
    p.queued_at = now;
    p.eta = now.checked_add(cfg.delay_s).ok_or(GovError::TooEarly)?;
    p.status = ProposalStatus::Queued;
    p.bump = ctx.bumps.proposal;
    cfg.proposal_count += 1;
    emit!(ProposalQueued { id: p.id, target_program, eta: p.eta, description_hash });
    Ok(())
}
