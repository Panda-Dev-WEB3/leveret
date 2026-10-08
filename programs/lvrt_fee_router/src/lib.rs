//! lvrt_fee_router — fees split 80% to workers (LLP bucket incl. the
//! insurance carve-out, keepers, liquidators, oracle operators), 10%
//! treasury, 5% stakers, 5% burn (Overview §5). $LVRT is never a revenue
//! claim: the staker share pays for first-loss capital that can be slashed.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{assert_upgrade_authority, lvrt_math::fees, seeds, USDC_MINT};
use lvrt_insurance::Fund;
use lvrt_vault::BucketState;

declare_id!("GxQSsXZi4uYAieZWyMBvk8c7dBbkKUQWJ5CoHKUHUeQF");

/// Oracle operators can receive at most 20% of total fees.
pub const MAX_OPERATORS_BPS: u16 = 2_000;

#[error_code]
pub enum RouterError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Bucket and insurance fund disagree")]
    BucketMismatch,
    #[msg("Nothing to distribute")]
    Empty,
    #[msg("Operator share above the 20% cap")]
    OperatorShareTooHigh,
    #[msg("Operator account required while the operator share is set")]
    MissingOperators,
    #[msg("Not implemented in the skeleton yet")]
    NotImplemented,
}

#[account]
#[derive(InitSpace)]
pub struct RouterConfig {
    pub authority: Pubkey,
    /// Treasury USDC account (10%).
    pub treasury: Pubkey,
    /// USDC accumulated for $LVRT buy-and-burn (5%).
    pub burn_vault: Pubkey,
    /// Oracle-operator USDC account and its share of total fees (bps),
    /// taken from the workers' 80% before the LP remainder.
    pub operators: Pubkey,
    pub operators_bps: u16,
    pub signer_bump: u8,
    pub bump: u8,
}

#[event]
pub struct FeesDistributed {
    pub bucket: lvrt_common::Bucket,
    pub total: u64,
    pub lp: u64,
    pub operators: u64,
    pub insurance: u64,
    pub treasury: u64,
    pub stakers: u64,
    pub burn: u64,
}

#[program]
pub mod lvrt_fee_router {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, treasury: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.treasury = treasury;
        c.burn_vault = ctx.accounts.burn_vault.key();
        c.operators = Pubkey::default();
        c.operators_bps = 0;
        c.signer_bump = ctx.bumps.router_signer;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Timelock: oracle-operator share of fees (≤ 20% of the total, out of
    /// the workers' 80%).
    pub fn set_operators(ctx: Context<SetOperators>, operators: Pubkey, operators_bps: u16) -> Result<()> {
        require!(operators_bps <= MAX_OPERATORS_BPS, RouterError::OperatorShareTooHigh);
        let c = &mut ctx.accounts.config;
        c.operators = operators;
        c.operators_bps = operators_bps;
        Ok(())
    }

    /// One fee inbox per LLP bucket; engine `settle_shard` pays fees here.
    pub fn init_inbox(_ctx: Context<InitInbox>, bucket: lvrt_common::Bucket) -> Result<()> {
        msg!("fee inbox for bucket {}", bucket.id());
        Ok(())
    }

    /// Permissionless crank: split everything in the bucket's fee inbox.
    pub fn distribute<'info>(ctx: Context<'info, Distribute<'info>>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.bucket_state.bucket == a.fund.bucket, RouterError::BucketMismatch);
        let total = a.inbox.amount;
        require!(total > 0, RouterError::Empty);
        let split = fees::split_fee(total, a.fund.fee_share_bps()).map_err(lvrt_common::math_err)?;

        // oracle operators come out of the workers' share, before the LP remainder
        let operators = (total as u128 * a.config.operators_bps as u128 / 10_000) as u64;
        let operators = operators.min(split.lp);
        let lp = split.lp - operators;
        if operators > 0 {
            let to = a.operators.as_ref().ok_or(RouterError::MissingOperators)?;
            send(a, to.to_account_info(), operators)?;
        }
        send(a, a.bucket_vault.to_account_info(), lp)?;
        // insurance top-up and staker rewards share the fund's vault
        send(a, a.insurance_vault.to_account_info(), split.insurance + split.stakers)?;
        send(a, a.treasury.to_account_info(), split.treasury)?;
        send(a, a.burn_vault.to_account_info(), split.burn)?;

        // the receiving ledgers move with the tokens
        if lp > 0 {
            cpi_credit_vault(a, lp)?;
        }
        if split.insurance + split.stakers > 0 {
            cpi_credit_insurance(a, split.insurance, split.stakers)?;
        }
        emit!(FeesDistributed {
            bucket: a.fund.bucket,
            total,
            lp,
            operators,
            insurance: split.insurance,
            treasury: split.treasury,
            stakers: split.stakers,
            burn: split.burn,
        });
        Ok(())
    }

    /// TODO(fee_router): swap `burn_vault` USDC for $LVRT via Jupiter and burn it.
    pub fn buy_and_burn(_ctx: Context<Initialize>) -> Result<()> {
        err!(RouterError::NotImplemented)
    }
}

#[inline(never)]
fn cpi_credit_vault<'info>(a: &Distribute<'info>, amount: u64) -> Result<()> {
    let bump = a.config.signer_bump;
    lvrt_vault::cpi::credit_fees(
        CpiContext::new_with_signer(
            lvrt_vault::ID,
            lvrt_vault::cpi::accounts::CreditFees {
                router_signer: a.router_signer.to_account_info(),
                config: a.vault_config.to_account_info(),
                bucket_state: a.bucket_state.to_account_info(),
                usdc_vault: a.bucket_vault.to_account_info(),
            },
            &[&[seeds::ROUTER, &[bump]]],
        ),
        amount,
    )
}

#[inline(never)]
fn cpi_credit_insurance<'info>(a: &Distribute<'info>, insurance: u64, stakers: u64) -> Result<()> {
    let bump = a.config.signer_bump;
    lvrt_insurance::cpi::credit_fees(
        CpiContext::new_with_signer(
            lvrt_insurance::ID,
            lvrt_insurance::cpi::accounts::CreditFees {
                router_signer: a.router_signer.to_account_info(),
                config: a.insurance_config.to_account_info(),
                fund: a.fund.to_account_info(),
                usdc_vault: a.insurance_vault.to_account_info(),
            },
            &[&[seeds::ROUTER, &[bump]]],
        ),
        insurance,
        stakers,
    )
}

#[inline(never)]
fn send<'info>(a: &Distribute<'info>, to: AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let bump = a.config.signer_bump;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.inbox.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to,
                authority: a.router_signer.to_account_info(),
            },
            &[&[seeds::ROUTER, &[bump]]],
        ),
        amount,
        a.usdc_mint.decimals,
    )
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + RouterConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Box<Account<'info, RouterConfig>>,
    /// CHECK: router signer PDA, owner of the inbox and burn vault.
    #[account(seeds = [seeds::ROUTER], bump)]
    pub router_signer: UncheckedAccount<'info>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = payer, seeds = [seeds::ROUTER, b"burn"], bump,
        token::mint = usdc_mint, token::authority = router_signer, token::token_program = token_program,
    )]
    pub burn_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bucket: lvrt_common::Bucket)]
pub struct InitInbox<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, RouterConfig>>,
    /// CHECK: router signer PDA.
    #[account(seeds = [seeds::ROUTER], bump = config.signer_bump)]
    pub router_signer: UncheckedAccount<'info>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = payer, seeds = [seeds::FEE_INBOX, &[bucket.id()]], bump,
        token::mint = usdc_mint, token::authority = router_signer, token::token_program = token_program,
    )]
    pub inbox: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, RouterConfig>>,
    /// CHECK: router signer PDA.
    #[account(seeds = [seeds::ROUTER], bump = config.signer_bump)]
    pub router_signer: UncheckedAccount<'info>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The fee inbox of exactly this bucket.
    #[account(mut, seeds = [seeds::FEE_INBOX, &[bucket_state.bucket.id()]], bump)]
    pub inbox: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump, seeds::program = lvrt_vault::ID)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump, seeds::program = lvrt_insurance::ID)]
    pub fund: Box<Account<'info, Fund>>,
    /// CHECK: verified by lvrt_vault in the CPI.
    pub vault_config: UncheckedAccount<'info>,
    /// CHECK: verified by lvrt_insurance in the CPI.
    pub insurance_config: UncheckedAccount<'info>,
    #[account(mut, address = bucket_state.usdc_vault)]
    pub bucket_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Receives the insurance carve-out and the staker share (tracked
    /// separately in the fund's ledger).
    #[account(mut, address = fund.usdc_vault)]
    pub insurance_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.treasury)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = config.burn_vault)]
    pub burn_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Required while `operators_bps > 0`.
    #[account(mut, address = config.operators)]
    pub operators: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    /// CHECK: CPI target.
    #[account(address = lvrt_vault::ID)]
    pub vault_program: UncheckedAccount<'info>,
    /// CHECK: CPI target.
    #[account(address = lvrt_insurance::ID)]
    pub insurance_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct SetOperators<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ RouterError::NotAuthority)]
    pub config: Box<Account<'info, RouterConfig>>,
}
