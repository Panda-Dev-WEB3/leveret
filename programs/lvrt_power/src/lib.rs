//! lvrt_power — Squared power perps, ratio perps, QuoteAMM, ShortVault, Crab
//! (Backend §7).
//!
//! S = underlying price, I = S² / SCALE, M = QuoteAMM mid.
//! f = clamp((M − I) / I, ±f_max), nf(t+dt) = nf(t)·(1 − f·dt/1d).
//! Long value = balance × nf × I; short debt = minted × nf × I.
//! A split k multiplies nf by k² so balances never change.
//! Invariants: Σ supply = Crab short + public shorts; protocol USDC ≥ AMM
//! inventory + all collateral; no code path seizes a long.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{
    assert_upgrade_authority,
    lvrt_math::{
        corporate::Ratio,
        power::{self as pw},
        NORM_SCALE,
    },
    seeds, MathResultExt, PriceStatus, Session, USDC_MINT,
};
use lvrt_oracle::PriceState;

declare_id!("ASwWQnPCrBMHryngMVhVzQTy4g5qeHena8kbDs3Z27N3");

#[error_code]
pub enum PowerError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Wrong price account")]
    WrongPriceState,
    #[msg("Oracle not usable; AMM halted (use redeem_at_index)")]
    OracleHalted,
    #[msg("Short minting is paused off-hours")]
    OffHoursMintPaused,
    #[msg("Collateral ratio too low")]
    Undercollateralized,
    #[msg("Quote outside the oracle band; route to ShortVault mint / Crab redeem")]
    OutsideBand,
    #[msg("Slippage")]
    Slippage,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Not implemented in the skeleton yet")]
    NotImplemented,
}

#[account]
#[derive(InitSpace)]
pub struct PowerConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PowerKind {
    /// I = S² / SCALE
    Squared,
    /// I = (P₁ / P₂) · SCALE, p = 1
    Ratio,
}

#[account]
#[derive(InitSpace)]
pub struct PowerMarket {
    pub id: u32,
    pub kind: PowerKind,
    pub price_state: Pubkey,
    /// Ratio markets only (denominator).
    pub price_state_2: Pubkey,
    pub power_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub token_vault: Pubkey,
    /// QuoteAMM reserves (protocol-owned).
    pub amm_usdc: u64,
    pub amm_tokens: u64,
    pub norm_factor: u128,
    pub last_accrual: i64,
    pub last_index: i64,
    /// Current daily funding, RATE_SCALE.
    pub funding: i64,
    pub public_short_minted: u64,
    pub crab_short_minted: u64,
    pub total_collateral: u64,
    pub bump: u8,
}

impl PowerMarket {
    /// The one number the UI shows.
    pub fn daily_carry_bps(&self) -> i64 {
        pw::daily_carry_bps(self.funding as i128)
    }
}

#[account]
#[derive(InitSpace)]
pub struct ShortVault {
    pub owner: Pubkey,
    pub market: Pubkey,
    pub collateral: u64,
    pub minted: u64,
    pub bump: u8,
}

fn usable(ps: &PriceState) -> Result<i64> {
    require!(matches!(ps.status, PriceStatus::Live | PriceStatus::Wide), PowerError::OracleHalted);
    Ok(if ps.session == Session::Closed && ps.last_close > 0 { ps.last_close } else { ps.mid })
}

fn current_index(m: &PowerMarket, ps: &PriceState, ps2: Option<&PriceState>) -> Result<i64> {
    match m.kind {
        PowerKind::Squared => pw::power_index(usable(ps)?).m(),
        PowerKind::Ratio => {
            let p2 = ps2.ok_or(PowerError::WrongPriceState)?;
            pw::ratio_index(usable(ps)?, usable(p2)?).m()
        }
    }
}

/// `accrue()` runs at the top of every instruction.
fn accrue(m: &mut PowerMarket, ps: &PriceState, ps2: Option<&PriceState>, now: i64) -> Result<i64> {
    let i = current_index(m, ps, ps2)?;
    let off = ps.session.is_off_hours();
    let f_max = if off { pw::F_MAX_OFF_HOURS } else { pw::F_MAX_SESSION };
    let mark = if m.amm_tokens > 0 && m.amm_usdc > 0 {
        pw::effective_index(m.amm_usdc as i128, m.amm_tokens as i128, m.norm_factor as i128).m()? as i64
    } else {
        i
    };
    let f = pw::power_funding(mark, i, f_max).m()?;
    let dt = (now - m.last_accrual).max(0);
    if dt > 0 {
        m.norm_factor = pw::accrue_norm_factor(m.norm_factor as i128, m.funding as i128, dt).m()? as u128;
        m.last_accrual = now;
    }
    m.funding = f as i64;
    m.last_index = i;
    Ok(i)
}

fn band_bps(ps: &PriceState) -> i64 {
    if ps.session.is_off_hours() {
        pw::AMM_BAND_OFF_HOURS_BPS
    } else {
        pw::AMM_BAND_SESSION_BPS
    }
}

#[program]
pub mod lvrt_power {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.guardian = guardian;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// TODO(power): add the Token-2022 metadata extension (name "NVDA²" etc.).
    pub fn create_power_market(ctx: Context<CreatePowerMarket>, id: u32, kind: PowerKind, price_state_2: Pubkey) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.id = id;
        m.kind = kind;
        m.price_state = ctx.accounts.price_state.key();
        m.price_state_2 = price_state_2;
        m.power_mint = ctx.accounts.power_mint.key();
        m.usdc_vault = ctx.accounts.usdc_vault.key();
        m.token_vault = ctx.accounts.token_vault.key();
        m.norm_factor = NORM_SCALE as u128;
        m.last_accrual = Clock::get()?.unix_timestamp;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    /// Permissionless accrual crank.
    pub fn accrue_funding(ctx: Context<Accrue>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let ps2 = ctx.accounts.price_state_2.as_deref();
        accrue(&mut ctx.accounts.market, &ctx.accounts.price_state, ps2, now)?;
        Ok(())
    }

    /// Mint shorts against USDC collateral (≥ 200%). Paused off-hours.
    pub fn mint_short(mut ctx: Context<MintShort>, collateral_in: u64, mint_amount: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts;
        require!(!a.price_state.session.is_off_hours(), PowerError::OffHoursMintPaused);
        require!(a.price_state.status == PriceStatus::Live, PowerError::OracleHalted);
        let i = accrue(&mut a.market, &a.price_state, None, now)?;
        let v = &mut a.short_vault;
        if v.owner == Pubkey::default() {
            v.owner = a.owner.key();
            v.market = a.market.key();
            v.bump = ctx.bumps.short_vault;
        }
        let collateral = v.collateral + collateral_in;
        let minted = v.minted + mint_amount;
        let debt = pw::position_value(minted, a.market.norm_factor as i128, i).m()?;
        require!(pw::collateral_ratio_bps(collateral as i64, debt) >= pw::SHORT_MINT_CR_BPS, PowerError::Undercollateralized);

        if collateral_in > 0 {
            token_interface::transfer_checked(
                CpiContext::new(
                    a.usdc_token_program.key(),
                    TransferChecked {
                        from: a.owner_usdc.to_account_info(),
                        mint: a.usdc_mint.to_account_info(),
                        to: a.usdc_vault.to_account_info(),
                        authority: a.owner.to_account_info(),
                    },
                ),
                collateral_in,
                a.usdc_mint.decimals,
            )?;
        }
        let id = a.market.id.to_le_bytes();
        token_interface::mint_to(
            CpiContext::new_with_signer(
                a.power_token_program.key(),
                MintTo { mint: a.power_mint.to_account_info(), to: a.owner_power.to_account_info(), authority: a.market.to_account_info() },
                &[&[seeds::POWER, &id, &[a.market.bump]]],
            ),
            mint_amount,
        )?;
        a.short_vault.collateral = collateral;
        a.short_vault.minted = minted;
        a.market.public_short_minted += mint_amount;
        a.market.total_collateral += collateral_in;
        Ok(())
    }

    /// Burn PowerTokens to reduce debt; optionally withdraw collateral while
    /// staying ≥ 150%.
    pub fn burn_short(mut ctx: Context<MintShort>, burn_amount: u64, collateral_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts;
        let i = accrue(&mut a.market, &a.price_state, None, now)?;
        require!(burn_amount <= a.short_vault.minted && collateral_out <= a.short_vault.collateral, PowerError::InvalidParams);
        let minted = a.short_vault.minted - burn_amount;
        let collateral = a.short_vault.collateral - collateral_out;
        let debt = pw::position_value(minted, a.market.norm_factor as i128, i).m()?;
        require!(minted == 0 || pw::collateral_ratio_bps(collateral as i64, debt) >= pw::SHORT_MAINTAIN_CR_BPS, PowerError::Undercollateralized);
        if burn_amount > 0 {
            token_interface::burn(
                CpiContext::new(
                    a.power_token_program.key(),
                    Burn { mint: a.power_mint.to_account_info(), from: a.owner_power.to_account_info(), authority: a.owner.to_account_info() },
                ),
                burn_amount,
            )?;
        }
        if collateral_out > 0 {
            let id = a.market.id.to_le_bytes();
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    a.usdc_token_program.key(),
                    TransferChecked {
                        from: a.usdc_vault.to_account_info(),
                        mint: a.usdc_mint.to_account_info(),
                        to: a.owner_usdc.to_account_info(),
                        authority: a.market.to_account_info(),
                    },
                    &[&[seeds::POWER, &id, &[a.market.bump]]],
                ),
                collateral_out,
                a.usdc_mint.decimals,
            )?;
        }
        a.short_vault.minted = minted;
        a.short_vault.collateral = collateral;
        a.market.public_short_minted -= burn_amount;
        a.market.total_collateral -= collateral_out;
        Ok(())
    }

    /// QuoteAMM buy inside [I(1−b), I(1+b)], 10 bps fee.
    pub fn amm_buy(mut ctx: Context<AmmTrade>, usdc_in: u64, min_tokens_out: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &mut ctx.accounts;
        let ps2 = a.price_state_2.as_deref();
        let i = accrue(&mut a.market, &a.price_state, ps2, now)?;
        let out = pw::amm_buy(a.market.amm_usdc, a.market.amm_tokens, usdc_in, a.market.norm_factor as i128, i, band_bps(&a.price_state))
            .m()?
            .ok_or(PowerError::OutsideBand)?;
        require!(out >= min_tokens_out, PowerError::Slippage);
        token_interface::transfer_checked(
            CpiContext::new(
                a.usdc_token_program.key(),
                TransferChecked {
                    from: a.user_usdc.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.usdc_vault.to_account_info(),
                    authority: a.user.to_account_info(),
                },
            ),
            usdc_in,
            a.usdc_mint.decimals,
        )?;
        let id = a.market.id.to_le_bytes();
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.power_token_program.key(),
                TransferChecked {
                    from: a.token_vault.to_account_info(),
                    mint: a.power_mint.to_account_info(),
                    to: a.user_power.to_account_info(),
                    authority: a.market.to_account_info(),
                },
                &[&[seeds::POWER, &id, &[a.market.bump]]],
            ),
            out,
            a.power_mint.decimals,
        )?;
        a.market.amm_usdc += usdc_in;
        a.market.amm_tokens -= out;
        Ok(())
    }

    /// TODO(power): AMM sell (always fills at ≥ I(1 − b), routing to Crab
    /// redeem when the AMM's USDC side is empty).
    pub fn amm_sell(_ctx: Context<AmmTrade>, _tokens_in: u64, _min_usdc_out: u64) -> Result<()> {
        err!(PowerError::NotImplemented)
    }

    /// TODO(power): 60-second uniform-price liquidation batches; bonus 5%
    /// scaled, close factor 50% (100% below 120%); off-hours only below 125%.
    pub fn liquidate_short(_ctx: Context<Accrue>) -> Result<()> {
        err!(PowerError::NotImplemented)
    }

    /// TODO(power): Crab vault — short PowerToken + long xStocks hedge via
    /// Jupiter (Scaled-UI aware), delta 0 ± band, 24h unlock, 10%/30d
    /// drawdown halt. NAV only, never shown as a rate.
    pub fn crab_deposit(_ctx: Context<Accrue>, _usdc: u64) -> Result<()> {
        err!(PowerError::NotImplemented)
    }

    /// TODO(power): when the oracle is paused, redeem at the last valid index
    /// with a per-slot cap.
    pub fn redeem_at_index(_ctx: Context<Accrue>, _tokens: u64) -> Result<()> {
        err!(PowerError::NotImplemented)
    }

    /// Split k: nf × k² at the effective time; no token balance changes.
    pub fn apply_split(ctx: Context<ApplySplit>, ratio_num: u32, ratio_den: u32) -> Result<()> {
        let m = &mut ctx.accounts.market;
        m.norm_factor = pw::split_norm_factor(m.norm_factor as i128, Ratio { num: ratio_num, den: ratio_den }).m()? as u128;
        Ok(())
    }
}

// ------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + PowerConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, PowerConfig>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(id: u32)]
pub struct CreatePowerMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ PowerError::NotAuthority)]
    pub config: Box<Account<'info, PowerConfig>>,
    #[account(init, payer = payer, space = 8 + PowerMarket::INIT_SPACE, seeds = [seeds::POWER, &id.to_le_bytes()], bump)]
    pub market: Box<Account<'info, PowerMarket>>,
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(
        init, payer = payer, seeds = [seeds::POWER_MINT, &id.to_le_bytes()], bump,
        mint::decimals = 6, mint::authority = market, mint::token_program = power_token_program,
    )]
    pub power_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = payer, seeds = [seeds::CUSTODY, &id.to_le_bytes()], bump,
        token::mint = usdc_mint, token::authority = market, token::token_program = usdc_token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init, payer = payer, seeds = [seeds::POWER, b"amm", &id.to_le_bytes()], bump,
        token::mint = power_mint, token::authority = market, token::token_program = power_token_program,
    )]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub power_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Accrue<'info> {
    #[account(mut, seeds = [seeds::POWER, &market.id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, PowerMarket>,
    #[account(address = market.price_state @ PowerError::WrongPriceState)]
    pub price_state: Account<'info, PriceState>,
    #[account(address = market.price_state_2 @ PowerError::WrongPriceState)]
    pub price_state_2: Option<Account<'info, PriceState>>,
}

#[derive(Accounts)]
pub struct MintShort<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [seeds::POWER, &market.id.to_le_bytes()],
        bump = market.bump,
        constraint = market.kind == PowerKind::Squared @ PowerError::InvalidParams
    )]
    pub market: Box<Account<'info, PowerMarket>>,
    #[account(address = market.price_state @ PowerError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + ShortVault::INIT_SPACE,
        seeds = [seeds::SHORT_VAULT, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub short_vault: Box<Account<'info, ShortVault>>,
    #[account(mut, address = market.power_mint)]
    pub power_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = power_mint, token::authority = owner)]
    pub owner_power: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = market.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub power_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AmmTrade<'info> {
    pub user: Signer<'info>,
    #[account(mut, seeds = [seeds::POWER, &market.id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, PowerMarket>>,
    #[account(address = market.price_state @ PowerError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(address = market.price_state_2 @ PowerError::WrongPriceState)]
    pub price_state_2: Option<Account<'info, PriceState>>,
    #[account(address = market.power_mint)]
    pub power_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = power_mint)]
    pub user_power: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = market.token_vault)]
    pub token_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = market.usdc_vault)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub power_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ApplySplit<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ PowerError::NotAuthority)]
    pub config: Account<'info, PowerConfig>,
    #[account(mut, seeds = [seeds::POWER, &market.id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, PowerMarket>,
}
