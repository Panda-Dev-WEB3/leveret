//! lvrt_insurance — per-bucket insurance funds and the staked $LVRT
//! first-loss tranche (Backend §5).
//!
//! Loss waterfall per bucket: position margin → bucket insurance fund →
//! staked $LVRT tranche for that bucket → bucket LLP NAV → ADL.
//! Funded by 20% of the bucket's fees until the target (5% of max OI), then
//! 5%. Below 50% of target the bucket goes reduce-only.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{assert_upgrade_authority, lvrt_math::vault as v, seeds, Bucket, USDC_MINT};

declare_id!("DwkxsoEc8sQBBqBovGsHBDvrmomdcPqy9aK2zFcUZxhQ");

pub const UNSTAKE_DELAY_S: i64 = 14 * 86_400;
pub const REWARD_PRECISION: u128 = 1_000_000_000_000;

#[error_code]
pub enum InsuranceError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Only the engine signer may draw on the fund")]
    NotEngine,
    #[msg("Unstake still cooling down")]
    Cooldown,
    #[msg("Insufficient stake")]
    InsufficientStake,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Not implemented in the skeleton yet")]
    NotImplemented,
}

#[account]
#[derive(InitSpace)]
pub struct InsuranceConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub engine_signer: Pubkey,
    pub usdc_mint: Pubkey,
    /// $LVRT (Token-2022, no extensions).
    pub lvrt_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Fund {
    pub bucket: Bucket,
    pub usdc_vault: Pubkey,
    pub stake_vault: Pubkey,
    /// USDC fund balance (ledger).
    pub balance: u64,
    pub target: u64,
    pub total_staked: u64,
    /// Σ staker USDC rewards per staked unit, × REWARD_PRECISION.
    pub reward_per_share: u128,
    pub rewards_unclaimed: u64,
    pub bump: u8,
}

impl Fund {
    pub fn reduce_only(&self) -> bool {
        v::bucket_reduce_only(self.balance as i64, self.target as i64)
    }
    pub fn fee_share_bps(&self) -> i64 {
        v::insurance_fee_share_bps(self.balance as i64, self.target as i64)
    }
}

#[account]
#[derive(InitSpace)]
pub struct Stake {
    pub owner: Pubkey,
    pub bucket: Bucket,
    pub amount: u64,
    pub reward_debt: u128,
    pub unstake_amount: u64,
    pub unstake_at: i64,
    pub bump: u8,
}

fn pending_rewards(f: &Fund, s: &Stake) -> u64 {
    ((s.amount as u128 * f.reward_per_share).saturating_sub(s.reward_debt) / REWARD_PRECISION) as u64
}

#[program]
pub mod lvrt_insurance {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey, engine_signer: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.guardian = guardian;
        c.engine_signer = engine_signer;
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.lvrt_mint = ctx.accounts.lvrt_mint.key();
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Target = 5% of the bucket's max OI.
    pub fn create_fund(ctx: Context<CreateFund>, bucket: Bucket, max_oi: u64) -> Result<()> {
        let f = &mut ctx.accounts.fund;
        f.bucket = bucket;
        f.usdc_vault = ctx.accounts.usdc_vault.key();
        f.stake_vault = ctx.accounts.stake_vault.key();
        f.target = v::insurance_target(max_oi as i64).map_err(lvrt_common::math_err)? as u64;
        f.bump = ctx.bumps.fund;
        Ok(())
    }

    pub fn set_target(ctx: Context<AuthorityFund>, max_oi: u64) -> Result<()> {
        ctx.accounts.fund.target = v::insurance_target(max_oi as i64).map_err(lvrt_common::math_err)? as u64;
        Ok(())
    }

    /// Anyone (normally the fee router) adds USDC to a fund.
    pub fn contribute(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.source.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.usdc_vault.to_account_info(),
                    authority: a.payer.to_account_info(),
                },
            ),
            amount,
            a.usdc_mint.decimals,
        )?;
        ctx.accounts.fund.balance += amount;
        Ok(())
    }

    /// Staker share of the bucket's fees (5%), credited pro rata.
    pub fn add_staker_rewards(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.fund.total_staked > 0, InsuranceError::InvalidParams);
        token_interface::transfer_checked(
            CpiContext::new(
                a.token_program.key(),
                TransferChecked {
                    from: a.source.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.usdc_vault.to_account_info(),
                    authority: a.payer.to_account_info(),
                },
            ),
            amount,
            a.usdc_mint.decimals,
        )?;
        let f = &mut ctx.accounts.fund;
        f.reward_per_share += amount as u128 * REWARD_PRECISION / f.total_staked as u128;
        f.rewards_unclaimed += amount;
        Ok(())
    }

    /// Engine-only (CPI from the loss waterfall): pay a bucket shortfall.
    /// Returns the amount covered; any remainder goes to the staked tranche.
    pub fn cover_shortfall(ctx: Context<CoverShortfall>, amount: u64) -> Result<u64> {
        let a = &ctx.accounts;
        let paid = amount.min(a.fund.balance);
        if paid > 0 {
            let id = [a.fund.bucket.id()];
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.token_program.key(),
                    TransferChecked {
                        from: a.usdc_vault.to_account_info(),
                        mint: a.usdc_mint.to_account_info(),
                        to: a.destination.to_account_info(),
                        authority: a.fund.to_account_info(),
                    },
                    &[&[seeds::INSURANCE, &id, &[a.fund.bump]]],
                ),
                paid,
                a.usdc_mint.decimals,
            )?;
        }
        ctx.accounts.fund.balance -= paid;
        Ok(paid)
    }

    /// TODO(insurance): slash the staked tranche pro rata at the published
    /// TWAP before LLP NAV is touched (needs the $LVRT TWAP source and a
    /// swap path for the slashed $LVRT).
    pub fn slash_tranche(_ctx: Context<CoverShortfall>, _amount: u64) -> Result<()> {
        err!(InsuranceError::NotImplemented)
    }

    pub fn stake(ctx: Context<StakeCtx>, amount: u64) -> Result<()> {
        require!(amount > 0, InsuranceError::InvalidParams);
        let a = &ctx.accounts;
        token_interface::transfer_checked(
            CpiContext::new(
                a.lvrt_token_program.key(),
                TransferChecked {
                    from: a.owner_lvrt.to_account_info(),
                    mint: a.lvrt_mint.to_account_info(),
                    to: a.stake_vault.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            amount,
            a.lvrt_mint.decimals,
        )?;
        let f = &mut ctx.accounts.fund;
        let s = &mut ctx.accounts.stake;
        if s.owner == Pubkey::default() {
            s.owner = ctx.accounts.owner.key();
            s.bucket = f.bucket;
            s.bump = ctx.bumps.stake;
        }
        // rewards accrued so far stay claimable
        let pending = pending_rewards(f, s);
        s.amount += amount;
        s.reward_debt = s.amount as u128 * f.reward_per_share - pending as u128 * REWARD_PRECISION;
        f.total_staked += amount;
        Ok(())
    }

    /// Starts the 14-day unstake; the stake keeps absorbing losses meanwhile.
    pub fn request_unstake(ctx: Context<StakeCtx>, amount: u64) -> Result<()> {
        let s = &mut ctx.accounts.stake;
        require!(amount > 0 && amount <= s.amount, InsuranceError::InsufficientStake);
        s.unstake_amount = amount;
        s.unstake_at = Clock::get()?.unix_timestamp + UNSTAKE_DELAY_S;
        Ok(())
    }

    /// TODO(insurance): pay `stake.unstake_amount` from `stake_vault` after
    /// `unstake_at` (signed by the fund PDA), settling rewards first.
    pub fn unstake(ctx: Context<StakeCtx>) -> Result<()> {
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.stake.unstake_at, InsuranceError::Cooldown);
        err!(InsuranceError::NotImplemented)
    }
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + InsuranceConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, InsuranceConfig>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub lvrt_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(bucket: Bucket)]
pub struct CreateFund<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ InsuranceError::NotAuthority)]
    pub config: Box<Account<'info, InsuranceConfig>>,
    #[account(init, payer = payer, space = 8 + Fund::INIT_SPACE, seeds = [seeds::INSURANCE, &[bucket.id()]], bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = config.lvrt_mint)]
    pub lvrt_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = payer, seeds = [seeds::CUSTODY, &[bucket.id()]], bump,
        token::mint = usdc_mint, token::authority = fund, token::token_program = usdc_token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init, payer = payer, seeds = [seeds::STAKE, &[bucket.id()]], bump,
        token::mint = lvrt_mint, token::authority = fund, token::token_program = lvrt_token_program,
    )]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub lvrt_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityFund<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ InsuranceError::NotAuthority)]
    pub config: Account<'info, InsuranceConfig>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Account<'info, Fund>,
}

#[derive(Accounts)]
pub struct Contribute<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = payer)]
    pub source: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = fund.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CoverShortfall<'info> {
    pub engine_signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = engine_signer @ InsuranceError::NotEngine)]
    pub config: Box<Account<'info, InsuranceConfig>>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = fund.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint)]
    pub destination: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct StakeCtx<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, InsuranceConfig>>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + Stake::INIT_SPACE,
        seeds = [seeds::STAKE, fund.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub stake: Box<Account<'info, Stake>>,
    #[account(address = config.lvrt_mint)]
    pub lvrt_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = lvrt_mint, token::authority = owner)]
    pub owner_lvrt: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = fund.stake_vault)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub lvrt_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}
