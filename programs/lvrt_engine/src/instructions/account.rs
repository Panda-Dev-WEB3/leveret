use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{lvrt_math::shard::shard_for, seeds, Family};

use crate::{
    error::EngineError,
    logic::account_health,
    state::{tool, Delegate, EngineConfig, MarginAccount, MAX_DELEGATES},
};

/// Owner, or a delegate whose tool mask covers `tool_bit`, within its
/// per-order and daily budgets (§11). `notional` = 0 for non-trading tools.
pub fn authorize(margin: &mut MarginAccount, signer: &Pubkey, tool_bit: u8, notional: u64, now: i64) -> Result<()> {
    if *signer == margin.owner {
        return Ok(());
    }
    let day = (now / 86_400) as u32;
    let d = margin
        .delegates
        .iter_mut()
        .find(|d| d.signer == *signer && d.signer != Pubkey::default())
        .ok_or(EngineError::NotAuthorized)?;
    require!(d.expiry > now && d.tool_mask & (1 << tool_bit) != 0, EngineError::NotAuthorized);
    require!(notional <= d.max_per_order, EngineError::DelegateBudget);
    if d.day != day {
        d.day = day;
        d.spent_today = 0;
    }
    d.spent_today = d.spent_today.checked_add(notional).ok_or(EngineError::DelegateBudget)?;
    require!(d.spent_today <= d.daily_budget, EngineError::DelegateBudget);
    Ok(())
}

pub fn family_tool_bit(f: Family) -> u8 {
    match f {
        Family::Core => 0,
        Family::Stocks => 1,
        Family::SmallCap => 2,
        Family::Squared => 3,
        Family::Factors => 4,
        Family::Tickets => 5,
        Family::Twins => 6,
    }
}

// ------------------------------------------------------------- open account

#[derive(Accounts)]
#[instruction(sub_id: u8)]
pub struct CreateMarginAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + MarginAccount::INIT_SPACE,
        seeds = [seeds::MARGIN, owner.key().as_ref(), &[sub_id]],
        bump
    )]
    pub margin: Box<Account<'info, MarginAccount>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_margin_account(ctx: Context<CreateMarginAccount>, sub_id: u8) -> Result<()> {
    let m = &mut ctx.accounts.margin;
    m.owner = ctx.accounts.owner.key();
    m.sub_id = sub_id;
    m.delegates = [Delegate::default(); MAX_DELEGATES];
    m.bump = ctx.bumps.margin;
    Ok(())
}

#[derive(Accounts)]
pub struct OwnerOnly<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ EngineError::NotAuthorized)]
    pub margin: Box<Account<'info, MarginAccount>>,
}

/// Agents act through delegates with a spending rulebook; the withdraw bit
/// must be set explicitly.
pub fn handle_set_delegate(ctx: Context<OwnerOnly>, slot: u8, delegate: Delegate) -> Result<()> {
    require!((slot as usize) < MAX_DELEGATES, EngineError::InvalidParams);
    let mut d = delegate;
    d.spent_today = 0;
    d.day = 0;
    ctx.accounts.margin.delegates[slot as usize] = d;
    Ok(())
}

// ------------------------------------------------------------------- deposit

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ EngineError::NotAuthorized)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, EngineConfig>>,
    #[account(address = config.usdc_mint @ EngineError::NotUsdc)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [seeds::CUSTODY, &[shard_for(&margin.key().to_bytes(), config.custody_count)]],
        bump,
    )]
    pub custody: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// USDC only. USDT deposits are swapped to USDC first (Jupiter exact-in,
/// 10 bps cap) by the client in the same transaction; see `deposit_usdt`.
pub fn handle_deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    require!(amount > 0, EngineError::InvalidParams);
    let a = &ctx.accounts;
    token_interface::transfer_checked(
        CpiContext::new(
            a.token_program.key(),
            TransferChecked {
                from: a.owner_usdc.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.custody.to_account_info(),
                authority: a.owner.to_account_info(),
            },
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    let m = &mut ctx.accounts.margin;
    m.collateral = m.collateral.checked_add(amount as i64).ok_or(EngineError::InvalidParams)?;
    Ok(())
}

// ------------------------------------------------------------------ withdraw

#[derive(Accounts)]
#[instruction(amount: u64, custody_index: u8)]
pub struct Withdraw<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, EngineConfig>>,
    /// CHECK: engine signer PDA.
    #[account(seeds = [seeds::AUTHORITY], bump = config.signer_bump)]
    pub engine_signer: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint @ EngineError::NotUsdc)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    /// Must belong to the margin account owner, even when a delegate signs.
    #[account(mut, token::mint = usdc_mint, token::authority = margin.owner)]
    pub owner_usdc: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [seeds::CUSTODY, &[custody_index]], bump)]
    pub custody: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Never gated by a pause. `remaining_accounts`: (Position, Market,
/// FundingState, PriceState) for every open position.
pub fn handle_withdraw<'info>(ctx: Context<'info, Withdraw<'info>>, amount: u64, _custody_index: u8) -> Result<()> {
    require!(amount > 0, EngineError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let margin_key = ctx.accounts.margin.key();
    authorize(&mut ctx.accounts.margin, &ctx.accounts.signer.key(), tool::WITHDRAW, 0, now)?;

    let m = &ctx.accounts.margin;
    require!(m.collateral >= amount as i64, EngineError::InsufficientMargin);
    if m.open_positions > 0 {
        let h = account_health(&margin_key, m, ctx.remaining_accounts)?;
        // isolated margin already left the ledger at open, so only cross IM counts
        require!(h.equity - amount as i64 >= h.initial.max(m.im_reserved as i64), EngineError::InsufficientMargin);
    }

    let a = &ctx.accounts;
    let bump = a.config.signer_bump;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.custody.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to: a.owner_usdc.to_account_info(),
                authority: a.engine_signer.to_account_info(),
            },
            &[&[seeds::AUTHORITY, &[bump]]],
        ),
        amount,
        a.usdc_mint.decimals,
    )?;
    ctx.accounts.margin.collateral -= amount as i64;
    Ok(())
}

/// TODO(engine): USDT → USDC via Jupiter exact-in with a 10 bps slippage cap
/// (the deposit reverts above it), then credit as `deposit`.
pub fn handle_deposit_usdt(_ctx: Context<OwnerOnly>, _amount: u64) -> Result<()> {
    err!(EngineError::NotImplemented)
}

/// Release circuit-breaker-queued profit after its 1h delay. The queue always pays.
pub fn handle_claim_queued_profit(ctx: Context<OwnerOnly>) -> Result<()> {
    let m = &mut ctx.accounts.margin;
    require!(m.queued_profit > 0, EngineError::Noop);
    require!(Clock::get()?.unix_timestamp >= m.queued_release_ts, EngineError::QueueLocked);
    m.collateral += m.queued_profit as i64;
    m.queued_profit = 0;
    Ok(())
}
