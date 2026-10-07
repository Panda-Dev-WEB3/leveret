//! lvrt_twins — spot-style Solana tokens that track a stock 1:1, backed by a
//! perp position and a USDC buffer (Backend §10).
//!
//! Mint: USDC → TwinVault opens a 1× long on the matching Stocks market →
//! Twin tokens minted at the oracle price (Token-2022 with metadata and the
//! Scaled UI Amount extension, authority = TwinVault). Redeem: burn → close
//! the long → USDC at oracle ± session spread; never gated. Dividends and the
//! holding fee are Scaled-UI multiplier steps, so raw balances never change.
//! Twins are not shares, carry no voting rights and are not issued by any
//! stock issuer.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use lvrt_common::{
    assert_upgrade_authority,
    lvrt_math::{margin as mm, notional},
    seeds, MathResultExt, USDC_MINT,
};
use lvrt_engine::{MarginAccount, Position};
use lvrt_oracle::PriceState;

declare_id!("7Q2Rsett1NBhw6SY2iFMNZbFznoXfkW2msJ3pjJPuzXC");

#[error_code]
pub enum TwinError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Wrong account for this twin")]
    WrongAccount,
    #[msg("Not implemented in the skeleton yet")]
    NotImplemented,
}

#[account]
#[derive(InitSpace)]
pub struct TwinsConfig {
    pub authority: Pubkey,
    pub guardian: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct TwinVault {
    /// e.g. "lNVDA".
    pub symbol: [u8; 8],
    /// Stocks market on lvrt_engine.
    pub market_id: u32,
    pub price_state: Pubkey,
    pub mint: Pubkey,
    /// lvrt_engine MarginAccount owned by this vault PDA.
    pub engine_margin: Pubkey,
    pub usdc_buffer: Pubkey,
    /// Funding buffer: 20% of mint/redeem fees + funding received.
    pub funding_buffer: u64,
    /// Sustained negative carry beyond this becomes a holding-fee step.
    pub holding_fee_threshold: u64,
    pub fee_bps: u16,
    pub bump: u8,
}

#[event]
pub struct Solvency {
    pub twin: Pubkey,
    pub twin_value: i64,
    pub backing: i64,
    pub solvent: bool,
}

#[program]
pub mod lvrt_twins {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey) -> Result<()> {
        assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.guardian = guardian;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// TODO(twins): initialise the mint with the Token-2022 Scaled UI Amount
    /// and metadata extensions (authority = vault PDA), and CPI
    /// `lvrt_engine::create_margin_account` signed by the vault PDA.
    pub fn create_twin(ctx: Context<CreateTwin>, symbol: [u8; 8], market_id: u32, engine_margin: Pubkey, fee_bps: u16) -> Result<()> {
        let v = &mut ctx.accounts.twin;
        v.symbol = symbol;
        v.market_id = market_id;
        v.price_state = ctx.accounts.price_state.key();
        v.mint = ctx.accounts.mint.key();
        v.engine_margin = engine_margin;
        v.usdc_buffer = ctx.accounts.usdc_buffer.key();
        v.fee_bps = fee_bps;
        v.bump = ctx.bumps.twin;
        Ok(())
    }

    /// TODO(twins): take USDC, CPI lvrt_engine deposit + open_position (1×
    /// long, cross) signed by the vault PDA, mint `usdc_net / oracle_ask`
    /// twins; 10 bps fee, 20% of it to the funding buffer.
    pub fn mint(_ctx: Context<Solvent>, _usdc_in: u64, _min_out: u64) -> Result<()> {
        err!(TwinError::NotImplemented)
    }

    /// TODO(twins): burn, CPI lvrt_engine close_position for the pro-rata
    /// size and withdraw; pays oracle ± session spread, off-hours at last
    /// close ± the off-hours spread. Never gated by a pause.
    pub fn redeem(_ctx: Context<Solvent>, _twins_in: u64, _min_usdc: u64) -> Result<()> {
        err!(TwinError::NotImplemented)
    }

    /// TODO(twins): at the ex-date, apply the engine's dividend credit as an
    /// upward Scaled-UI multiplier step (new_multiplier +
    /// new_multiplier_effective_timestamp); downward steps for holding fees.
    pub fn apply_multiplier_step(_ctx: Context<Solvent>) -> Result<()> {
        err!(TwinError::NotImplemented)
    }

    /// View: Σ twin value ≤ vault USDC + position equity. Published every
    /// slot by the receipts service; anyone can recheck it here.
    pub fn check_solvency(ctx: Context<Solvent>) -> Result<bool> {
        let a = &ctx.accounts;
        let mark = a.price_state.mid;
        let twin_value = notional(a.mint.supply as i64, mark).m()?;
        let p = &a.position;
        let upnl = mm::unrealized_pnl(p.size as i64, p.entry_px, mark).m()?;
        let backing = a.usdc_buffer.amount as i64 + a.engine_margin.collateral + upnl;
        let solvent = twin_value <= backing;
        emit!(Solvency { twin: a.twin.key(), twin_value, backing, solvent });
        Ok(solvent)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + TwinsConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, TwinsConfig>,
    /// CHECK: this program.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(symbol: [u8; 8], market_id: u32)]
pub struct CreateTwin<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ TwinError::NotAuthority)]
    pub config: Box<Account<'info, TwinsConfig>>,
    #[account(init, payer = payer, space = 8 + TwinVault::INIT_SPACE, seeds = [seeds::TWIN, &symbol], bump)]
    pub twin: Box<Account<'info, TwinVault>>,
    #[account(
        seeds = [seeds::PRICE, &market_id.to_le_bytes()],
        bump = price_state.bump,
        seeds::program = lvrt_oracle::ID,
    )]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(
        init, payer = payer, seeds = [seeds::TWIN_MINT, &symbol], bump,
        mint::decimals = 6, mint::authority = twin, mint::token_program = twin_token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = payer, seeds = [seeds::CUSTODY, &symbol], bump,
        token::mint = usdc_mint, token::authority = twin, token::token_program = usdc_token_program,
    )]
    pub usdc_buffer: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub twin_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Solvent<'info> {
    #[account(seeds = [seeds::TWIN, &twin.symbol], bump = twin.bump)]
    pub twin: Box<Account<'info, TwinVault>>,
    #[account(address = twin.mint @ TwinError::WrongAccount)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = twin.usdc_buffer @ TwinError::WrongAccount)]
    pub usdc_buffer: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = twin.engine_margin @ TwinError::WrongAccount)]
    pub engine_margin: Box<Account<'info, MarginAccount>>,
    #[account(
        constraint = position.margin == twin.engine_margin && position.market_id == twin.market_id @ TwinError::WrongAccount
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(address = twin.price_state @ TwinError::WrongAccount)]
    pub price_state: Box<Account<'info, PriceState>>,
}
