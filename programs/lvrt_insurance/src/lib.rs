//! lvrt_insurance — per-bucket insurance funds and the staked $LVRT
//! first-loss tranche (Backend §5).
//!
//! Loss waterfall per bucket: position margin → bucket insurance fund →
//! staked $LVRT tranche for that bucket → bucket LLP NAV → ADL.
//! Funded by 20% of the bucket's fees until the target (5% of max OI), then
//! 5%. Below 50% of target the bucket goes reduce-only.
//!
//! The tranche is a pool of $LVRT per bucket; stakes are shares of it, so a
//! slash (taking $LVRT out of the pool) is pro rata across every staker,
//! including those in their 14-day unstake cooldown. Slashed $LVRT is valued
//! at the published TWAP less a recovery discount, booked as a receivable in
//! the bucket's NAV, and sold from escrow at that price; proceeds go straight
//! to the bucket.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{
    assert_upgrade_authority,
    lvrt_math::{tranche as tr, vault as v},
    seeds, Bucket, MathResultExt, PriceStatus, USDC_MINT,
};
use lvrt_oracle::PriceState;

declare_id!("DwkxsoEc8sQBBqBovGsHBDvrmomdcPqy9aK2zFcUZxhQ");

pub const UNSTAKE_DELAY_S: i64 = 14 * 86_400;
pub const REWARD_PRECISION: u128 = 1_000_000_000_000;
/// A TWAP observation needs an oracle price at most this old.
pub const MAX_PRICE_AGE_S: i64 = 60;

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
    #[msg("$LVRT TWAP is stale; run update_twap first")]
    StaleTwap,
    #[msg("$LVRT price is not LIVE and fresh")]
    BadPrice,
    #[msg("Price above max_usdc")]
    Slippage,
    #[msg("Nothing to do")]
    Noop,
    #[msg("Invalid parameters")]
    InvalidParams,
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
    pub lvrt_decimals: u8,
    /// lvrt_oracle PriceState of the $LVRT market feeding the TWAP.
    pub lvrt_price_state: Pubkey,
    /// Published TWAP, USD per whole $LVRT (1e8).
    pub twap: i64,
    pub twap_ts: i64,
    pub twap_window_s: i64,
    pub recovery_discount_bps: u16,
    pub bump: u8,
}

impl InsuranceConfig {
    /// Price slashed $LVRT is valued and sold at: a fresh TWAP less the discount.
    pub fn recovery_price(&self, now: i64) -> Result<i64> {
        require!(self.twap > 0 && now - self.twap_ts <= tr::MAX_TWAP_AGE_S, InsuranceError::StaleTwap);
        tr::recovery_price(self.twap, self.recovery_discount_bps as i64).m()
    }
}

#[account]
#[derive(InitSpace)]
pub struct Fund {
    pub bucket: Bucket,
    pub usdc_vault: Pubkey,
    pub stake_vault: Pubkey,
    pub slash_escrow: Pubkey,
    /// USDC fund balance (ledger).
    pub balance: u64,
    pub target: u64,
    /// $LVRT backing the tranche.
    pub total_staked: u64,
    pub total_shares: u64,
    /// Bumped when a slash empties the pool; older shares are worthless.
    pub share_epoch: u32,
    /// Σ staker USDC rewards per share, × REWARD_PRECISION.
    pub reward_per_share: u128,
    pub rewards_unclaimed: u64,
    /// Slashed $LVRT awaiting sale, and the USDC still owed to the bucket for it.
    pub escrow_lvrt: u64,
    pub recovery_owed: u64,
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
    pub fund: Pubkey,
    pub shares: u64,
    pub epoch: u32,
    pub reward_debt: u128,
    /// Rewards earned but not yet claimed.
    pub rewards_owed: u64,
    pub unstake_shares: u64,
    pub unstake_at: i64,
    pub bump: u8,
}

#[event]
pub struct TrancheSlashed {
    pub bucket: Bucket,
    pub lvrt: u64,
    pub usdc_covered: u64,
    pub price: i64,
    pub staked_after: u64,
    pub wiped: bool,
}

#[event]
pub struct RecoverySold {
    pub bucket: Bucket,
    pub buyer: Pubkey,
    pub lvrt: u64,
    pub proceeds: u64,
    pub receivable_settled: u64,
}

/// Move earned rewards into `rewards_owed` and drop shares from an old epoch.
fn sync_stake(f: &Fund, s: &mut Stake) {
    if s.epoch != f.share_epoch {
        // the pool was wiped by a slash: these shares are worth nothing
        s.shares = 0;
        s.unstake_shares = 0;
        s.reward_debt = 0;
        s.epoch = f.share_epoch;
        return;
    }
    let earned = (s.shares as u128 * f.reward_per_share).saturating_sub(s.reward_debt) / REWARD_PRECISION;
    s.rewards_owed += earned as u64;
    s.reward_debt = s.shares as u128 * f.reward_per_share;
}

#[program]
pub mod lvrt_insurance {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey, engine_signer: Pubkey, lvrt_price_state: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.guardian = guardian;
        c.engine_signer = engine_signer;
        c.usdc_mint = ctx.accounts.usdc_mint.key();
        c.lvrt_mint = ctx.accounts.lvrt_mint.key();
        c.lvrt_decimals = ctx.accounts.lvrt_mint.decimals;
        c.lvrt_price_state = lvrt_price_state;
        c.twap_window_s = tr::DEFAULT_TWAP_WINDOW_S;
        c.recovery_discount_bps = tr::DEFAULT_RECOVERY_DISCOUNT_BPS as u16;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Timelock: TWAP source and window, recovery discount.
    pub fn set_tranche_params(ctx: Context<AuthorityConfig>, lvrt_price_state: Pubkey, twap_window_s: i64, recovery_discount_bps: u16) -> Result<()> {
        require!(twap_window_s > 0 && recovery_discount_bps < 5_000, InsuranceError::InvalidParams);
        let c = &mut ctx.accounts.config;
        if c.lvrt_price_state != lvrt_price_state {
            c.twap = 0; // a new source re-seeds the TWAP
        }
        c.lvrt_price_state = lvrt_price_state;
        c.twap_window_s = twap_window_s;
        c.recovery_discount_bps = recovery_discount_bps;
        Ok(())
    }

    /// Target = 5% of the bucket's max OI.
    pub fn create_fund(ctx: Context<CreateFund>, bucket: Bucket, max_oi: u64) -> Result<()> {
        let f = &mut ctx.accounts.fund;
        f.bucket = bucket;
        f.usdc_vault = ctx.accounts.usdc_vault.key();
        f.stake_vault = ctx.accounts.stake_vault.key();
        f.slash_escrow = ctx.accounts.slash_escrow.key();
        f.target = v::insurance_target(max_oi as i64).m()? as u64;
        f.bump = ctx.bumps.fund;
        Ok(())
    }

    pub fn set_target(ctx: Context<AuthorityFund>, max_oi: u64) -> Result<()> {
        ctx.accounts.fund.target = v::insurance_target(max_oi as i64).m()? as u64;
        Ok(())
    }

    /// Permissionless: fold the current $LVRT oracle price into the TWAP.
    pub fn update_twap(ctx: Context<UpdateTwap>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let ps = &ctx.accounts.price_state;
        require!(ps.status == PriceStatus::Live && now * 1_000 - ps.ts_ms <= MAX_PRICE_AGE_S * 1_000, InsuranceError::BadPrice);
        let c = &mut ctx.accounts.config;
        let dt = if c.twap > 0 { (now - c.twap_ts).max(0) } else { 0 };
        c.twap = tr::ema_twap(c.twap, ps.mid, dt, c.twap_window_s).m()?;
        c.twap_ts = now;
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

    /// Staker share of the bucket's fees (5%), credited per share.
    pub fn add_staker_rewards(ctx: Context<Contribute>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.fund.total_shares > 0, InsuranceError::InvalidParams);
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
        f.reward_per_share += amount as u128 * REWARD_PRECISION / f.total_shares as u128;
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

    /// Engine-only (next waterfall step): cover up to `uncovered` USDC by
    /// moving $LVRT from the pool to escrow at the recovery price. Returns the
    /// USDC covered, which the engine books as the bucket's receivable.
    pub fn slash_tranche(ctx: Context<SlashTranche>, uncovered: u64) -> Result<u64> {
        let a = &ctx.accounts;
        if uncovered == 0 || a.fund.total_staked == 0 {
            return Ok(0);
        }
        let price = a.config.recovery_price(Clock::get()?.unix_timestamp)?;
        let s = tr::slash(uncovered, a.fund.total_staked, price, a.config.lvrt_decimals).m()?;
        if s.lvrt > 0 {
            let id = [a.fund.bucket.id()];
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.lvrt_token_program.key(),
                    TransferChecked {
                        from: a.stake_vault.to_account_info(),
                        mint: a.lvrt_mint.to_account_info(),
                        to: a.slash_escrow.to_account_info(),
                        authority: a.fund.to_account_info(),
                    },
                    &[&[seeds::INSURANCE, &id, &[a.fund.bump]]],
                ),
                s.lvrt,
                a.lvrt_mint.decimals,
            )?;
        }
        let f = &mut ctx.accounts.fund;
        f.total_staked -= s.lvrt;
        f.escrow_lvrt += s.lvrt;
        f.recovery_owed += s.usdc;
        let wiped = f.total_staked == 0;
        if wiped {
            f.total_shares = 0;
            f.share_epoch += 1;
        }
        emit!(TrancheSlashed { bucket: f.bucket, lvrt: s.lvrt, usdc_covered: s.usdc, price, staked_after: f.total_staked, wiped });
        Ok(s.usdc)
    }

    /// Anyone buys escrowed $LVRT at the current recovery price; the USDC goes
    /// straight into the LLP bucket and settles the matching share of the
    /// receivable.
    pub fn buy_slashed(ctx: Context<BuySlashed>, lvrt: u64, max_usdc: u64) -> Result<()> {
        let a = &ctx.accounts;
        let f = &a.fund;
        require!(lvrt > 0 && lvrt <= f.escrow_lvrt, InsuranceError::InvalidParams);
        let price = a.config.recovery_price(Clock::get()?.unix_timestamp)?;
        let cost = tr::value_usdc_up(lvrt, price, a.config.lvrt_decimals).m()?;
        require!(cost <= max_usdc, InsuranceError::Slippage);
        let settled = if lvrt == f.escrow_lvrt {
            f.recovery_owed
        } else {
            (f.recovery_owed as u128 * lvrt as u128 / f.escrow_lvrt as u128) as u64
        };

        token_interface::transfer_checked(
            CpiContext::new(
                a.usdc_token_program.key(),
                TransferChecked {
                    from: a.buyer_usdc.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.bucket_vault.to_account_info(),
                    authority: a.buyer.to_account_info(),
                },
            ),
            cost,
            a.usdc_mint.decimals,
        )?;
        let id = [f.bucket.id()];
        let signer: &[&[&[u8]]] = &[&[seeds::INSURANCE, &id, &[f.bump]]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.lvrt_token_program.key(),
                TransferChecked {
                    from: a.slash_escrow.to_account_info(),
                    mint: a.lvrt_mint.to_account_info(),
                    to: a.buyer_lvrt.to_account_info(),
                    authority: a.fund.to_account_info(),
                },
                signer,
            ),
            lvrt,
            a.lvrt_mint.decimals,
        )?;
        lvrt_vault::cpi::collect_recovery(
            CpiContext::new_with_signer(
                lvrt_vault::ID,
                lvrt_vault::cpi::accounts::CollectRecovery {
                    fund_signer: a.fund.to_account_info(),
                    config: a.vault_config.to_account_info(),
                    bucket_state: a.bucket_state.to_account_info(),
                    usdc_vault: a.bucket_vault.to_account_info(),
                },
                signer,
            ),
            cost,
            settled,
        )?;

        let f = &mut ctx.accounts.fund;
        f.escrow_lvrt -= lvrt;
        f.recovery_owed -= settled;
        emit!(RecoverySold { bucket: f.bucket, buyer: ctx.accounts.buyer.key(), lvrt, proceeds: cost, receivable_settled: settled });
        Ok(())
    }

    pub fn stake(ctx: Context<StakeCtx>, amount: u64) -> Result<()> {
        let a = &ctx.accounts;
        let shares = tr::shares_for_stake(amount, a.fund.total_shares, a.fund.total_staked).m()?;
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
        let fund_key = ctx.accounts.fund.key();
        let f = &mut ctx.accounts.fund;
        let s = &mut ctx.accounts.stake;
        if s.owner == Pubkey::default() {
            s.owner = ctx.accounts.owner.key();
            s.fund = fund_key;
            s.epoch = f.share_epoch;
            s.bump = ctx.bumps.stake;
        }
        sync_stake(f, s);
        s.shares += shares;
        s.reward_debt = s.shares as u128 * f.reward_per_share;
        f.total_shares += shares;
        f.total_staked += amount;
        Ok(())
    }

    /// Starts the 14-day unstake; the shares keep absorbing slashes meanwhile.
    pub fn request_unstake(ctx: Context<StakeOwner>, shares: u64) -> Result<()> {
        let f = &ctx.accounts.fund;
        let s = &mut ctx.accounts.stake;
        sync_stake(f, s);
        require!(shares > 0 && shares <= s.shares, InsuranceError::InsufficientStake);
        s.unstake_shares = shares;
        s.unstake_at = Clock::get()?.unix_timestamp + UNSTAKE_DELAY_S;
        Ok(())
    }

    /// After the cooldown: pay out the $LVRT now backing the requested shares
    /// (less if the pool was slashed in the meantime).
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        {
            let f = &ctx.accounts.fund;
            let s = &mut ctx.accounts.stake;
            sync_stake(f, s);
            require!(s.unstake_shares > 0, InsuranceError::Noop);
            require!(now >= s.unstake_at, InsuranceError::Cooldown);
        }
        let a = &ctx.accounts;
        let shares = a.stake.unstake_shares;
        let out = tr::lvrt_for_shares(shares, a.fund.total_shares, a.fund.total_staked).m()?;
        if out > 0 {
            let id = [a.fund.bucket.id()];
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.lvrt_token_program.key(),
                    TransferChecked {
                        from: a.stake_vault.to_account_info(),
                        mint: a.lvrt_mint.to_account_info(),
                        to: a.owner_lvrt.to_account_info(),
                        authority: a.fund.to_account_info(),
                    },
                    &[&[seeds::INSURANCE, &id, &[a.fund.bump]]],
                ),
                out,
                a.lvrt_mint.decimals,
            )?;
        }
        let f = &mut ctx.accounts.fund;
        let s = &mut ctx.accounts.stake;
        s.shares -= shares;
        s.unstake_shares = 0;
        s.reward_debt = s.shares as u128 * f.reward_per_share;
        f.total_shares -= shares;
        f.total_staked -= out;
        Ok(())
    }

    pub fn claim_rewards(ctx: Context<ClaimRewards>) -> Result<()> {
        {
            let f = &ctx.accounts.fund;
            let s = &mut ctx.accounts.stake;
            sync_stake(f, s);
        }
        let a = &ctx.accounts;
        let amount = a.stake.rewards_owed.min(a.fund.rewards_unclaimed);
        require!(amount > 0, InsuranceError::Noop);
        let id = [a.fund.bucket.id()];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.token_program.key(),
                TransferChecked {
                    from: a.usdc_vault.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.owner_usdc.to_account_info(),
                    authority: a.fund.to_account_info(),
                },
                &[&[seeds::INSURANCE, &id, &[a.fund.bump]]],
            ),
            amount,
            a.usdc_mint.decimals,
        )?;
        ctx.accounts.stake.rewards_owed -= amount;
        ctx.accounts.fund.rewards_unclaimed -= amount;
        Ok(())
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
pub struct AuthorityConfig<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ InsuranceError::NotAuthority)]
    pub config: Account<'info, InsuranceConfig>,
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
    #[account(
        init, payer = payer, seeds = [seeds::SLASH_ESCROW, &[bucket.id()]], bump,
        token::mint = lvrt_mint, token::authority = fund, token::token_program = lvrt_token_program,
    )]
    pub slash_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
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
pub struct UpdateTwap<'info> {
    #[account(mut, seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, InsuranceConfig>,
    #[account(address = config.lvrt_price_state @ InsuranceError::BadPrice)]
    pub price_state: Account<'info, PriceState>,
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
pub struct SlashTranche<'info> {
    pub engine_signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = engine_signer @ InsuranceError::NotEngine)]
    pub config: Box<Account<'info, InsuranceConfig>>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(address = config.lvrt_mint)]
    pub lvrt_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = fund.stake_vault)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = fund.slash_escrow)]
    pub slash_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub lvrt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct BuySlashed<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, InsuranceConfig>>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(address = config.lvrt_mint)]
    pub lvrt_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = fund.slash_escrow)]
    pub slash_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = lvrt_mint)]
    pub buyer_lvrt: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = buyer)]
    pub buyer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: verified by lvrt_vault in the CPI.
    pub vault_config: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [seeds::BUCKET, &[fund.bucket.id()]],
        bump = bucket_state.bump,
        seeds::program = lvrt_vault::ID,
    )]
    pub bucket_state: Box<Account<'info, lvrt_vault::BucketState>>,
    #[account(mut, address = bucket_state.usdc_vault)]
    pub bucket_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: CPI target.
    #[account(address = lvrt_vault::ID)]
    pub vault_program: UncheckedAccount<'info>,
    pub lvrt_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
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

#[derive(Accounts)]
pub struct StakeOwner<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        mut,
        seeds = [seeds::STAKE, fund.key().as_ref(), owner.key().as_ref()],
        bump = stake.bump,
        has_one = owner,
    )]
    pub stake: Box<Account<'info, Stake>>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    pub owner: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, InsuranceConfig>>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        mut,
        seeds = [seeds::STAKE, fund.key().as_ref(), owner.key().as_ref()],
        bump = stake.bump,
        has_one = owner,
    )]
    pub stake: Box<Account<'info, Stake>>,
    #[account(address = config.lvrt_mint)]
    pub lvrt_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = lvrt_mint)]
    pub owner_lvrt: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = fund.stake_vault)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub lvrt_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [seeds::INSURANCE, &[fund.bucket.id()]], bump = fund.bump)]
    pub fund: Box<Account<'info, Fund>>,
    #[account(
        mut,
        seeds = [seeds::STAKE, fund.key().as_ref(), owner.key().as_ref()],
        bump = stake.bump,
        has_one = owner,
    )]
    pub stake: Box<Account<'info, Stake>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = fund.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}
