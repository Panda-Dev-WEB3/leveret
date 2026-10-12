//! lvrt_twins — spot-style Solana tokens that track a stock 1:1, backed by a
//! perp position and a USDC buffer (Backend §10).
//!
//! Mint: USDC → the twin's engine margin account (owned by a data-less signer
//! PDA) opens a 1× long on the matching Stocks market → Twin tokens minted at
//! the engine's fill price, one twin per base unit of the long. Redeem: burn →
//! close that slice of the long → USDC at the engine's exit fill (oracle ± the
//! session spread; last close when the session is closed); never gated by a
//! pause. The 10 bps twin fee stays in the margin account as the buffer that
//! absorbs funding, so the vault stays ≥ 1× backed.
//! Twins are not shares, carry no voting rights and are not issued by any
//! stock issuer.

use anchor_lang::{
    prelude::*,
    system_program::{self, Transfer},
};
use anchor_spl::token_interface::{self, Burn, Mint, MintTo, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{
    assert_upgrade_authority,
    lvrt_math::{margin as mm, notional, pricing, shard::shard_for, Side as MSide},
    seeds, MathResultExt, Side, USDC_MINT,
};
use lvrt_engine::{
    logic,
    program::LvrtEngine,
    EngineConfig, FundingState, MarginAccount, Market, OpenArgs, Position,
};
use lvrt_oracle::PriceState;

declare_id!("7Q2Rsett1NBhw6SY2iFMNZbFznoXfkW2msJ3pjJPuzXC");

/// Twin fee cap (bps of notional, each way).
const MAX_FEE_BPS: u16 = 100;

#[error_code]
pub enum TwinError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Wrong account for this twin")]
    WrongAccount,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Price moved past the slippage limit")]
    Slippage,
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
    /// lvrt_engine MarginAccount owned by the twin signer PDA.
    pub engine_margin: Pubkey,
    pub usdc_buffer: Pubkey,
    /// Funding buffer (accounting): 20% of mint/redeem fees. The USDC itself
    /// sits in the margin account as surplus collateral.
    pub funding_buffer: u64,
    /// Sustained negative carry beyond this becomes a holding-fee step.
    pub holding_fee_threshold: u64,
    pub fee_bps: u16,
    pub bump: u8,
    pub signer_bump: u8,
}

#[event]
pub struct Solvency {
    pub twin: Pubkey,
    pub twin_value: i64,
    pub backing: i64,
    pub solvent: bool,
}

#[event]
pub struct TwinEvent {
    pub twin: Pubkey,
    /// 0 = mint, 1 = redeem
    pub kind: u8,
    pub user: Pubkey,
    pub twins: u64,
    pub price: i64,
    pub usdc: u64,
    pub fee: u64,
}

fn signer_seeds<'a>(symbol: &'a [u8; 8], bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [seeds::TWIN_SIGNER, symbol, bump]
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

    /// Create a twin: mint (authority = the twin signer PDA), USDC pass-through
    /// account, and the engine margin account owned by the signer PDA, which
    /// is funded here for that account's rent and the long's position rent.
    /// TODO(twins): Token-2022 Scaled UI Amount + metadata extensions on the mint.
    pub fn create_twin(ctx: Context<CreateTwin>, symbol: [u8; 8], market_id: u32, fee_bps: u16, holding_fee_threshold: u64) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, TwinError::InvalidParams);
        require!(ctx.accounts.engine_market.price_state == ctx.accounts.price_state.key(), TwinError::WrongAccount);
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(0) + rent.minimum_balance(8 + MarginAccount::INIT_SPACE) + rent.minimum_balance(8 + Position::INIT_SPACE);
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.payer.to_account_info(), to: ctx.accounts.twin_signer.to_account_info() },
            ),
            lamports.saturating_sub(ctx.accounts.twin_signer.lamports()),
        )?;
        let bump = [ctx.bumps.twin_signer];
        let s = signer_seeds(&symbol, &bump);
        lvrt_engine::cpi::create_margin_account(
            CpiContext::new_with_signer(
                ctx.accounts.engine_program.key(),
                lvrt_engine::cpi::accounts::CreateMarginAccount {
                    owner: ctx.accounts.twin_signer.to_account_info(),
                    margin: ctx.accounts.engine_margin.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                },
                &[&s],
            ),
            0,
        )?;
        let v = &mut ctx.accounts.twin;
        v.symbol = symbol;
        v.market_id = market_id;
        v.price_state = ctx.accounts.price_state.key();
        v.mint = ctx.accounts.mint.key();
        v.engine_margin = ctx.accounts.engine_margin.key();
        v.usdc_buffer = ctx.accounts.usdc_buffer.key();
        v.fee_bps = fee_bps;
        v.holding_fee_threshold = holding_fee_threshold;
        v.bump = ctx.bumps.twin;
        v.signer_bump = ctx.bumps.twin_signer;
        Ok(())
    }

    /// Mint `twins` (base units = the long's size) for at most `max_usdc_in`:
    /// the engine's own fill for a 1× long of that size, its fee, and the twin
    /// fee. The signed price must be posted earlier in the same transaction.
    pub fn mint(ctx: Context<MintRedeem>, twins: u64, max_usdc_in: u64) -> Result<()> {
        require!(twins > 0, TwinError::InvalidParams);
        let a = &ctx.accounts;
        let ps = &a.price_state;
        // the engine's step-3 fill for an open, computed on the same accounts
        let fill = pricing::fill_price(MSide::Long, twins as i64, ps.mid, ps.bid, ps.ask, ps.band_bps, a.funding_state.skew(), &logic::spread_params(&a.engine_market, ps.session), 0).m()?;
        let n = notional(twins as i64, fill.price).m()?.unsigned_abs();
        let engine_fee = logic::fee_for(&a.engine_market, &a.engine_margin, n as i64)?;
        let twin_fee = fee_of(n, a.twin.fee_bps);
        let total = n + engine_fee + twin_fee;
        require!(total <= max_usdc_in, TwinError::Slippage);

        token_interface::transfer_checked(
            CpiContext::new(
                a.usdc_token_program.key(),
                TransferChecked {
                    from: a.user_usdc.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.usdc_buffer.to_account_info(),
                    authority: a.user.to_account_info(),
                },
            ),
            total,
            a.usdc_mint.decimals,
        )?;
        let symbol = a.twin.symbol;
        let bump = [a.twin.signer_bump];
        let s = signer_seeds(&symbol, &bump);
        lvrt_engine::cpi::deposit(
            CpiContext::new_with_signer(
                a.engine_program.key(),
                lvrt_engine::cpi::accounts::Deposit {
                    owner: a.twin_signer.to_account_info(),
                    margin: a.engine_margin.to_account_info(),
                    config: a.engine_config.to_account_info(),
                    usdc_mint: a.usdc_mint.to_account_info(),
                    owner_usdc: a.usdc_buffer.to_account_info(),
                    custody: a.engine_custody.to_account_info(),
                    token_program: a.usdc_token_program.to_account_info(),
                },
                &[&s],
            ),
            total,
        )?;
        lvrt_engine::cpi::open_position(
            CpiContext::new_with_signer(
                a.engine_program.key(),
                lvrt_engine::cpi::accounts::OpenPosition {
                    signer: a.twin_signer.to_account_info(),
                    config: a.engine_config.to_account_info(),
                    margin: a.engine_margin.to_account_info(),
                    market: a.engine_market.to_account_info(),
                    funding_state: a.funding_state.to_account_info(),
                    price_state: a.price_state.to_account_info(),
                    shard: a.shard.to_account_info(),
                    position: a.position.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                },
                &[&s],
            ),
            OpenArgs { side: Side::Long, size: twins, price_bound: fill.price, leverage_x100: 100, isolated_margin: 0 },
        )?;
        token_interface::mint_to(
            CpiContext::new_with_signer(
                a.twin_token_program.key(),
                MintTo { mint: a.mint.to_account_info(), to: a.user_twin.to_account_info(), authority: a.twin_signer.to_account_info() },
                &[&s],
            ),
            twins,
        )?;
        let twin_key = a.twin.key();
        let user = a.user.key();
        let v = &mut ctx.accounts.twin;
        v.funding_buffer += twin_fee / 5;
        emit!(TwinEvent { twin: twin_key, kind: 0, user, twins, price: fill.price, usdc: total, fee: twin_fee });
        Ok(())
    }

    /// Burn `twins_in` and receive the engine's exit fill for that slice of
    /// the long, less its fee and the twin fee (at least `min_usdc_out`).
    /// The payout is capped at what the slice actually released into the
    /// margin account (equity after the close less the margin the rest of the
    /// long still reserves), so an engine haircut on a quick round trip falls
    /// on the redeemer, not on the remaining holders. Never gated by a pause;
    /// off-hours the engine exits at the last close.
    pub fn redeem<'info>(ctx: Context<'info, MintRedeem<'info>>, twins_in: u64, min_usdc_out: u64) -> Result<()> {
        require!(twins_in > 0, TwinError::InvalidParams);
        let clock = Clock::get()?;
        let a = &ctx.accounts;
        require!(*a.position.owner == lvrt_engine::ID, TwinError::WrongAccount);
        let pos = {
            let data = a.position.try_borrow_data()?;
            Position::try_deserialize(&mut &data[..])?
        };
        require!(pos.margin == a.engine_margin.key() && pos.market_id == a.twin.market_id, TwinError::WrongAccount);
        require!(twins_in <= pos.size, TwinError::InvalidParams);
        let ps = &a.price_state;
        let q = logic::exit_quote(&a.engine_market, ps, logic::now_ms(&clock))?;
        let fill = pricing::fill_price(MSide::Short, twins_in as i64, q.mid, q.bid, q.ask, ps.band_bps, a.funding_state.skew(), &logic::spread_params(&a.engine_market, ps.session), q.extra_bps).m()?;
        let n = notional(twins_in as i64, fill.price).m()?.unsigned_abs();
        let engine_fee = logic::fee_for(&a.engine_market, &a.engine_margin, n as i64)?;
        let twin_fee = fee_of(n, a.twin.fee_bps);
        let quoted = n.saturating_sub(engine_fee + twin_fee);
        require!(quoted > 0 && quoted >= min_usdc_out, TwinError::Slippage);
        let still_open = twins_in < pos.size;

        token_interface::burn(
            CpiContext::new(
                a.twin_token_program.key(),
                Burn { mint: a.mint.to_account_info(), from: a.user_twin.to_account_info(), authority: a.user.to_account_info() },
            ),
            twins_in,
        )?;
        let symbol = a.twin.symbol;
        let bump = [a.twin.signer_bump];
        let s = signer_seeds(&symbol, &bump);
        lvrt_engine::cpi::close_position(
            CpiContext::new_with_signer(
                a.engine_program.key(),
                lvrt_engine::cpi::accounts::ClosePosition {
                    signer: a.twin_signer.to_account_info(),
                    margin: a.engine_margin.to_account_info(),
                    market: a.engine_market.to_account_info(),
                    funding_state: a.funding_state.to_account_info(),
                    price_state: a.price_state.to_account_info(),
                    shard: a.shard.to_account_info(),
                    position: a.position.to_account_info(),
                    owner: a.twin_signer.to_account_info(),
                },
                &[&s],
            ),
            twins_in,
            fill.price,
        )?;

        // what the close released: equity after it, less the rest's reservation
        ctx.accounts.engine_margin.reload()?;
        let a = &ctx.accounts;
        let releasable = if still_open {
            let rest = {
                let data = a.position.try_borrow_data()?;
                Position::try_deserialize(&mut &data[..])?
            };
            let h = logic::position_health(&rest, &a.engine_market, &a.funding_state, &a.price_state)?;
            a.engine_margin.collateral + h.upnl - h.carry - h.initial.max(a.engine_margin.im_reserved as i64)
        } else {
            a.engine_margin.collateral
        };
        let payout = quoted.min(releasable.max(0) as u64);
        require!(payout > 0 && payout >= min_usdc_out, TwinError::Slippage);
        let custody_index = shard_for(&a.engine_margin.key().to_bytes(), a.engine_config.custody_count);
        let health = if still_open {
            vec![a.position.to_account_info(), a.engine_market.to_account_info(), a.funding_state.to_account_info(), a.price_state.to_account_info()]
        } else {
            vec![]
        };
        lvrt_engine::cpi::withdraw(
            CpiContext::new_with_signer(
                a.engine_program.key(),
                lvrt_engine::cpi::accounts::Withdraw {
                    signer: a.twin_signer.to_account_info(),
                    margin: a.engine_margin.to_account_info(),
                    config: a.engine_config.to_account_info(),
                    engine_signer: a.engine_signer.to_account_info(),
                    usdc_mint: a.usdc_mint.to_account_info(),
                    owner_usdc: a.usdc_buffer.to_account_info(),
                    custody: a.engine_custody.to_account_info(),
                    token_program: a.usdc_token_program.to_account_info(),
                },
                &[&s],
            )
            .with_remaining_accounts(health),
            payout,
            custody_index,
        )?;
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                a.usdc_token_program.key(),
                TransferChecked {
                    from: a.usdc_buffer.to_account_info(),
                    mint: a.usdc_mint.to_account_info(),
                    to: a.user_usdc.to_account_info(),
                    authority: a.twin_signer.to_account_info(),
                },
                &[&s],
            ),
            payout,
            a.usdc_mint.decimals,
        )?;
        let twin_key = a.twin.key();
        let user = a.user.key();
        let v = &mut ctx.accounts.twin;
        if payout == quoted {
            v.funding_buffer += twin_fee / 5;
        }
        emit!(TwinEvent { twin: twin_key, kind: 1, user, twins: twins_in, price: fill.price, usdc: payout, fee: twin_fee });
        Ok(())
    }

    /// TODO(twins): at the ex-date, apply the engine's dividend credit as an
    /// upward Scaled-UI multiplier step (new_multiplier +
    /// new_multiplier_effective_timestamp); downward steps for holding fees
    /// once sustained negative carry exceeds `holding_fee_threshold`.
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

fn fee_of(notional: u64, bps: u16) -> u64 {
    ((notional as u128 * bps as u128).div_ceil(10_000)) as u64
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
    /// Owns the engine margin account and signs for it; a system account so
    /// it can pay the engine's rent.
    #[account(mut, seeds = [seeds::TWIN_SIGNER, &symbol], bump)]
    pub twin_signer: SystemAccount<'info>,
    #[account(
        seeds = [seeds::PRICE, &market_id.to_le_bytes()],
        bump = price_state.bump,
        seeds::program = lvrt_oracle::ID,
    )]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(
        seeds = [seeds::MARKET, &market_id.to_le_bytes()],
        bump = engine_market.bump,
        seeds::program = lvrt_engine::ID,
    )]
    pub engine_market: Box<Account<'info, Market>>,
    #[account(
        init, payer = payer, seeds = [seeds::TWIN_MINT, &symbol], bump,
        mint::decimals = 6, mint::authority = twin_signer, mint::token_program = twin_token_program,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init, payer = payer, seeds = [seeds::CUSTODY, &symbol], bump,
        token::mint = usdc_mint, token::authority = twin_signer, token::token_program = usdc_token_program,
    )]
    pub usdc_buffer: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: created by lvrt_engine (`[MARGIN, twin_signer, 0]`).
    #[account(mut)]
    pub engine_margin: UncheckedAccount<'info>,
    pub engine_program: Program<'info, LvrtEngine>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub twin_token_program: Interface<'info, TokenInterface>,
    pub usdc_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MintRedeem<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, seeds = [seeds::TWIN, &twin.symbol], bump = twin.bump)]
    pub twin: Box<Account<'info, TwinVault>>,
    #[account(mut, seeds = [seeds::TWIN_SIGNER, &twin.symbol], bump = twin.signer_bump)]
    pub twin_signer: SystemAccount<'info>,
    #[account(mut, address = twin.mint @ TwinError::WrongAccount)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_twin: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(address = USDC_MINT)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint, token::authority = user)]
    pub user_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = twin.usdc_buffer @ TwinError::WrongAccount)]
    pub usdc_buffer: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(seeds = [seeds::CONFIG], bump = engine_config.bump, seeds::program = lvrt_engine::ID)]
    pub engine_config: Box<Account<'info, EngineConfig>>,
    /// CHECK: lvrt_engine's signer PDA (checked by the engine on withdraw).
    pub engine_signer: UncheckedAccount<'info>,
    #[account(mut, address = twin.engine_margin @ TwinError::WrongAccount)]
    pub engine_margin: Box<Account<'info, MarginAccount>>,
    /// CHECK: the margin account's custody shard (checked by the engine).
    #[account(mut)]
    pub engine_custody: UncheckedAccount<'info>,
    #[account(
        seeds = [seeds::MARKET, &twin.market_id.to_le_bytes()],
        bump = engine_market.bump,
        seeds::program = lvrt_engine::ID,
    )]
    pub engine_market: Box<Account<'info, Market>>,
    #[account(
        seeds = [seeds::FUNDING, &twin.market_id.to_le_bytes()],
        bump = funding_state.bump,
        seeds::program = lvrt_engine::ID,
    )]
    pub funding_state: Box<Account<'info, FundingState>>,
    #[account(address = twin.price_state @ TwinError::WrongAccount)]
    pub price_state: Box<Account<'info, PriceState>>,
    /// CHECK: the margin account's shard of the market (checked by the engine).
    #[account(mut)]
    pub shard: UncheckedAccount<'info>,
    /// CHECK: the vault's long (created by the engine on the first mint).
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    pub engine_program: Program<'info, LvrtEngine>,
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
