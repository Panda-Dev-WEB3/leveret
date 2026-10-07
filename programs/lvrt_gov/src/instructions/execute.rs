use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program::invoke_signed,
    },
};
use lvrt_common::seeds;

use crate::{
    error::GovError,
    state::{GovConfig, Proposal, ProposalExecuted, ProposalStatus, GRACE_PERIOD_S},
};

/// Permissionless once the ETA has passed. `remaining_accounts` must be the
/// proposal's accounts in order, followed by the target program account.
#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, GovConfig>,
    #[account(mut, seeds = [seeds::PROPOSAL, &proposal.id.to_le_bytes()], bump = proposal.bump)]
    pub proposal: Account<'info, Proposal>,
    /// CHECK: PDA signer for the proposed instruction.
    #[account(seeds = [seeds::EXECUTOR], bump = config.executor_bump)]
    pub executor: UncheckedAccount<'info>,
}

pub fn handle_execute<'info>(ctx: Context<'info, Execute<'info>>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let executor_key = ctx.accounts.executor.key();
    let p = &mut ctx.accounts.proposal;
    require!(p.status == ProposalStatus::Queued, GovError::NotPending);
    require!(now >= p.eta, GovError::TooEarly);
    require!(now <= p.eta.saturating_add(GRACE_PERIOD_S), GovError::Expired);

    let rem = ctx.remaining_accounts;
    require!(rem.len() == p.accounts.len() + 1, GovError::AccountMismatch);
    for (ai, m) in rem.iter().zip(p.accounts.iter()) {
        require_keys_eq!(ai.key(), m.pubkey, GovError::AccountMismatch);
    }
    require_keys_eq!(rem[p.accounts.len()].key(), p.target_program, GovError::AccountMismatch);

    let ix = Instruction {
        program_id: p.target_program,
        accounts: p
            .accounts
            .iter()
            .map(|m| AccountMeta {
                pubkey: m.pubkey,
                // the executor PDA is the only signer a proposal can carry
                is_signer: m.is_signer && m.pubkey == executor_key,
                is_writable: m.is_writable,
            })
            .collect(),
        data: p.data.clone(),
    };

    // Persist Executed before the CPI so a re-entrant execute cannot replay it.
    p.status = ProposalStatus::Executed;
    let id = p.id;
    let target = p.target_program;
    p.exit(&crate::ID)?;

    // The executor PDA is not in `rem` (its meta is), so pass it explicitly.
    let mut infos = rem.to_vec();
    infos.push(ctx.accounts.executor.to_account_info());
    let bump = ctx.accounts.config.executor_bump;
    invoke_signed(&ix, &infos, &[&[seeds::EXECUTOR, &[bump]]])?;
    emit!(ProposalExecuted { id, target_program: target, executed_at: now });
    Ok(())
}
