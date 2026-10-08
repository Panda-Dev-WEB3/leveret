//! lvrt_vault — LLP buckets (Backend §4).
//!
//! NAV = USDC + accrued fees − unrealized trader PnL − pending payouts.
//! Mint/redeem at NAV ± 5 bps. Withdrawals are instant while utilization
//! < 50%, otherwise they wait 48h and pay the NAV at the end of the queue.
//! LP shares accrue NAV from fees and trader losses and can lose from trader
//! gains — never presented as yield.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{assert_upgrade_authority, lvrt_math::vault as v, seeds, Bucket, MathResultExt, USDC_MINT};

pub mod state;
pub use state::*;

declare_id!("AdFxcb9gcQTPKFo5MyU7MK5M18orENK4ZNfd7vWBKh3h");

/// NAV inputs older than this block deposits/redeems.
pub const MAX_NAV_AGE_S: i64 = 120;

#[error_code]
pub enum VaultError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Only the engine signer may call this")]
    NotEngine,
    #[msg("Only USDC")]
    NotUsdc,
    #[msg("NAV is stale; run the exposure report first")]
    StaleNav,
    #[msg("Withdrawal still queued")]
    Queued,
    #[msg("Instant withdrawal not available above 50% utilization")]
    UseQueue,
    #[msg("Insufficient bucket liquidity")]
    Insufficient,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Only this bucket's insurance fund may settle a recovery")]
    NotInsurance,
    #[msg("Not implemented in the skeleton yet")]
    NotImplemented,
}

fn bucket_seeds(b: &BucketState) -> [u8; 1] {
    [b.bucket.id()]
}

#[program]
pub mod lvrt_vault {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey, engine_signer: Pubkey, insurance_program: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.guardian = guardian;
        c.engine_signer = engine_signer;
        c.insurance_program = insurance_program;
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_bucket(ctx: Context<CreateBucket>, bucket: Bucket, max_oi: u64, utilization_cap_bps: u16) -> Result<()> {
        let b = &mut ctx.accounts.bucket_state;
        b.bucket = bucket;
        b.lp_mint = ctx.accounts.lp_mint.key();
        b.usdc_vault = ctx.accounts.usdc_vault.key();
        b.lp_escrow = ctx.accounts.lp_escrow.key();
        b.max_oi = max_oi;
        b.utilization_cap_bps = utilization_cap_bps;
        b.nav_ts = Clock::get()?.unix_timestamp;
        b.bump = ctx.bumps.bucket_state;
        Ok(())
    }

    /// Deposit USDC, receive LP shares at NAV + 5 bps. The first deposit locks
    /// `DEAD_SHARES` in the escrow to defeat empty-bucket share inflation.
    pub fn deposit(ctx: Context<Deposit>, amount: u64, min_shares: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        require!(now - a.bucket_state.nav_ts <= MAX_NAV_AGE_S, VaultError::StaleNav);
        let supply = a.lp_mint.supply;
        let mut shares = v::shares_for_deposit(amount, a.bucket_state.nav(), supply).m()?;
        let dead = if supply == 0 { v::DEAD_SHARES.min(shares) } else { 0 };
        shares -= dead;
        require!(shares >= min_shares && shares > 0, VaultError::InvalidParams);

        token_interface::transfer_checked(
            CpiContext::new(
                a.usdc_token_program.key(),
                TransferChecked {
                    from: a.depositor_usdc.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.usdc_vault.to_account_info(),
                    authority: a.depositor.to_account_info(),
                },
            ),
            amount,
            a.usdc_mint.decimals,
        )?;
        let id = bucket_seeds(&a.bucket_state);
        let signer: &[&[&[u8]]] = &[&[seeds::BUCKET, &id, &[a.bucket_state.bump]]];
        for (to, n) in [(a.depositor_lp.to_account_info(), shares), (a.lp_escrow.to_account_info(), dead)] {
            if n > 0 {
                token_interface::mint_to(
                    CpiContext::new_with_signer(
                        a.lp_token_program.key(),
                        MintTo { mint: a.lp_mint.to_account_info(), to, authority: a.bucket_state.to_account_info() },
                        signer,
                    ),
                    n,
                )?;
            }
        }
        ctx.accounts.bucket_state.usdc_balance += amount;
        Ok(())
    }

    /// Instant redeem while utilization < 50%.
    pub fn redeem(ctx: Context<Redeem>, shares: u64, min_usdc: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        let b = &a.bucket_state;
        require!(now - b.nav_ts <= MAX_NAV_AGE_S, VaultError::StaleNav);
        require!(v::withdraw_is_instant(b.utilization_bps()), VaultError::UseQueue);
        let out = v::usdc_for_redeem(shares, b.nav(), a.lp_mint.supply).m()?;
        require!(out >= min_usdc && out <= b.usdc_balance, VaultError::Insufficient);
        token_interface::burn(
            CpiContext::new(
                a.lp_token_program.key(),
                Burn { mint: a.lp_mint.to_account_info(), from: a.owner_lp.to_account_info(), authority: a.owner.to_account_info() },
            ),
            shares,
        )?;
        pay_out(a, out)?;
        ctx.accounts.bucket_state.usdc_balance -= out;
        Ok(())
    }

    /// Above 50% utilization: escrow shares for 48h.
    pub fn request_withdrawal(ctx: Context<RequestWithdrawal>, shares: u64, nonce: u64) -> Result<()> {
        require!(shares > 0, VaultError::InvalidParams);
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.lp_token_program.key(),
                TransferChecked {
                    from: a.owner_lp.to_account_info(),
                    mint: a.lp_mint.to_account_info(),
                    to: a.lp_escrow.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            shares,
            a.lp_mint.decimals,
        )?;
        let w = &mut ctx.accounts.withdrawal;
        w.owner = ctx.accounts.owner.key();
        w.bucket = ctx.accounts.bucket_state.bucket;
        w.shares = shares;
        w.requested_at = now;
        w.unlock_at = now + v::WITHDRAW_QUEUE_S;
        w.nonce = nonce;
        w.bump = ctx.bumps.withdrawal;
        ctx.accounts.bucket_state.queued_shares += shares;
        Ok(())
    }

    /// Pays at the NAV at the end of the queue. The queue always pays.
    pub fn complete_withdrawal(ctx: Context<CompleteWithdrawal>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        require!(now >= a.withdrawal.unlock_at, VaultError::Queued);
        require!(now - a.bucket_state.nav_ts <= MAX_NAV_AGE_S, VaultError::StaleNav);
        let shares = a.withdrawal.shares;
        let out = v::usdc_for_redeem(shares, a.bucket_state.nav(), a.lp_mint.supply).m()?;
        require!(out <= a.bucket_state.usdc_balance, VaultError::Insufficient);
        let id = bucket_seeds(&a.bucket_state);
        let signer: &[&[&[u8]]] = &[&[seeds::BUCKET, &id, &[a.bucket_state.bump]]];
        token_interface::burn(
            CpiContext::new_with_signer(
                a.lp_token_program.key(),
                Burn { mint: a.lp_mint.to_account_info(), from: a.lp_escrow.to_account_info(), authority: a.bucket_state.to_account_info() },
                signer,
            ),
            shares,
        )?;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.usdc_token_program.key(),
                TransferChecked {
                    from: a.usdc_vault.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.owner_usdc.to_account_info(),
                    authority: a.bucket_state.to_account_info(),
                },
                signer,
            ),
            out,
            a.usdc_mint.decimals,
        )?;
        let b = &mut ctx.accounts.bucket_state;
        b.usdc_balance -= out;
        b.queued_shares -= shares;
        Ok(())
    }

    /// Engine-only (CPI signed by the engine signer PDA): mark trader PnL and
    /// open exposure so NAV is current.
    pub fn report_exposure(ctx: Context<EngineOnly>, trader_upnl: i64, reserved_notional: u64, accrued_fees: u64) -> Result<()> {
        let b = &mut ctx.accounts.bucket_state;
        b.trader_upnl = trader_upnl;
        b.reserved_notional = reserved_notional;
        b.accrued_fees = accrued_fees;
        b.nav_ts = Clock::get()?.unix_timestamp;
        emit!(NavUpdated { bucket: b.bucket, nav: b.nav(), supply: 0, ts: b.nav_ts });
        Ok(())
    }

    /// Engine-only: net settlement of realized trader PnL. `incoming` USDC was
    /// already transferred into `usdc_vault` by the engine (trader losses,
    /// insurance cover); `outgoing` is paid to engine custody (trader gains);
    /// `receivable` is bad debt covered by slashed $LVRT awaiting sale.
    pub fn settle_from_engine(ctx: Context<SettleFromEngine>, incoming: u64, outgoing: u64, receivable: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.usdc_vault.amount >= a.bucket_state.usdc_balance + incoming, VaultError::InvalidParams);
        if outgoing > 0 {
            require!(outgoing <= a.bucket_state.usdc_balance + incoming, VaultError::Insufficient);
            let id = bucket_seeds(&a.bucket_state);
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.usdc_token_program.key(),
                    TransferChecked {
                        from: a.usdc_vault.to_account_info(),
                        mint: a.usdc_mint.to_account_info(),
                        to: a.engine_custody.to_account_info(),
                        authority: a.bucket_state.to_account_info(),
                    },
                    &[&[seeds::BUCKET, &id, &[a.bucket_state.bump]]],
                ),
                outgoing,
                a.usdc_mint.decimals,
            )?;
        }
        let b = &mut ctx.accounts.bucket_state;
        b.usdc_balance = b.usdc_balance + incoming - outgoing;
        b.slash_receivable += receivable;
        Ok(())
    }

    /// Insurance-fund-only (CPI signed by this bucket's fund PDA): `proceeds`
    /// USDC from a slashed-$LVRT sale has been paid into `usdc_vault`, settling
    /// `receivable_reduction` of the receivable. Any difference is the market
    /// moving since the slash and lands in NAV.
    pub fn collect_recovery(ctx: Context<CollectRecovery>, proceeds: u64, receivable_reduction: u64) -> Result<()> {
        let a = &ctx.accounts;
        let id = [a.bucket_state.bucket.id()];
        let (fund, _) = Pubkey::find_program_address(&[seeds::INSURANCE, &id], &a.config.insurance_program);
        require_keys_eq!(a.fund_signer.key(), fund, VaultError::NotInsurance);
        require!(receivable_reduction <= a.bucket_state.slash_receivable, VaultError::InvalidParams);
        require!(a.usdc_vault.amount >= a.bucket_state.usdc_balance + proceeds, VaultError::InvalidParams);
        let b = &mut ctx.accounts.bucket_state;
        b.usdc_balance += proceeds;
        b.slash_receivable -= receivable_reduction;
        Ok(())
    }

    /// TODO(vault): composite "LLP" router — split one deposit across buckets
    /// by weight in a single transaction (remaining accounts per bucket).
    pub fn deposit_composite(_ctx: Context<EngineOnly>) -> Result<()> {
        err!(VaultError::NotImplemented)
    }
}

fn pay_out(a: &Redeem, out: u64) -> Result<()> {
    let id = bucket_seeds(&a.bucket_state);
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.usdc_token_program.key(),
            TransferChecked {
                from: a.usdc_vault.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.owner_usdc.to_account_info(),
                authority: a.bucket_state.to_account_info(),
            },
            &[&[seeds::BUCKET, &id, &[a.bucket_state.bump]]],
        ),
        out,
        a.usdc_mint.decimals,
    )
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + VaultConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, VaultConfig>,
    #[account(address = USDC_MINT @ VaultError::NotUsdc)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bucket: Bucket)]
pub struct CreateBucket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ VaultError::NotAuthority)]
    pub config: Account<'info, VaultConfig>,
    #[account(init, payer = payer, space = 8 + BucketState::INIT_SPACE, seeds = [seeds::BUCKET, &[bucket.id()]], bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::LP_MINT, &[bucket.id()]],
        bump,
        mint::decimals = 6,
        mint::authority = bucket_state,
        mint::token_program = lp_token_program,
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::WITHDRAWAL, &[bucket.id()]],
        bump,
        token::mint = lp_mint,
        token::authority = bucket_state,
        token::token_program = lp_token_program,
    )]
    pub lp_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::CUSTODY, &[bucket.id()]],
        bump,
        token::mint = usdc_mint,
        token::authority = bucket_state,
        token::token_program = usdc_token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub lp_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(mut, address = bucket_state.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = bucket_state.lp_escrow)]
    pub lp_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = lp_mint)]
    pub depositor_lp: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT @ VaultError::NotUsdc)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = depositor)]
    pub depositor_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = bucket_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub lp_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(mut, address = bucket_state.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = lp_mint, token::authority = owner)]
    pub owner_lp: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT @ VaultError::NotUsdc)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = bucket_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub lp_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(shares: u64, nonce: u64)]
pub struct RequestWithdrawal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(address = bucket_state.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = lp_mint, token::authority = owner)]
    pub owner_lp: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = bucket_state.lp_escrow)]
    pub lp_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = owner,
        space = 8 + Withdrawal::INIT_SPACE,
        seeds = [seeds::WITHDRAWAL, owner.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub withdrawal: Account<'info, Withdrawal>,
    pub lp_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CompleteWithdrawal<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(
        mut,
        close = owner,
        has_one = owner,
        constraint = withdrawal.bucket == bucket_state.bucket @ VaultError::InvalidParams
    )]
    pub withdrawal: Account<'info, Withdrawal>,
    #[account(mut, address = bucket_state.lp_mint)]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = bucket_state.lp_escrow)]
    pub lp_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT @ VaultError::NotUsdc)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = bucket_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub lp_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct EngineOnly<'info> {
    pub engine_signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = engine_signer @ VaultError::NotEngine)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump)]
    pub bucket_state: Account<'info, BucketState>,
}

#[derive(Accounts)]
pub struct SettleFromEngine<'info> {
    pub engine_signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = engine_signer @ VaultError::NotEngine)]
    pub config: Account<'info, VaultConfig>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = bucket_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = engine_signer)]
    pub engine_custody: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CollectRecovery<'info> {
    /// The insurance fund PDA of this bucket (checked in the handler).
    pub fund_signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, VaultConfig>>,
    #[account(mut, seeds = [seeds::BUCKET, &[bucket_state.bucket.id()]], bump = bucket_state.bump)]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(address = bucket_state.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}
