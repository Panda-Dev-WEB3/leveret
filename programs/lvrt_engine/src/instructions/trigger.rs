use anchor_lang::prelude::*;
use lvrt_common::{lvrt_math::BPS, seeds, Side};
use lvrt_oracle::PriceState;

use crate::{
    error::EngineError,
    instructions::account::authorize,
    logic::{mark_price, reduce, ReduceKind},
    state::{FillEvent, FundingState, MarginAccount, Market, MarketShard, Position, Trigger, TriggerKind},
};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct TriggerArgs {
    pub market_id: u32,
    pub side: Side,
    pub kind: TriggerKind,
    pub trigger_px: i64,
    pub size: u64,
    pub expiry: i64,
    pub max_slippage_bps: u16,
    pub keeper_bounty: u64,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct PlaceTrigger<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(
        init,
        payer = signer,
        space = 8 + Trigger::INIT_SPACE,
        seeds = [seeds::TRIGGER, margin.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub trigger: Box<Account<'info, Trigger>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_place_trigger(ctx: Context<PlaceTrigger>, nonce: u64, args: TriggerArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.trigger_px > 0 && args.size > 0 && args.expiry > now, EngineError::InvalidParams);
    authorize(&mut ctx.accounts.margin, &ctx.accounts.signer.key(), 0, 0, now)?;
    let t = &mut ctx.accounts.trigger;
    t.margin = ctx.accounts.margin.key();
    t.owner = ctx.accounts.margin.owner;
    t.market_id = args.market_id;
    t.side = args.side;
    t.kind = args.kind;
    t.trigger_px = args.trigger_px;
    t.size = args.size;
    t.expiry = args.expiry;
    t.max_slippage_bps = args.max_slippage_bps;
    t.keeper_bounty = args.keeper_bounty;
    t.nonce = nonce;
    t.bump = ctx.bumps.trigger;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelTrigger<'info> {
    pub signer: Signer<'info>,
    #[account(mut, address = trigger.margin)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(mut, close = owner)]
    pub trigger: Box<Account<'info, Trigger>>,
    /// CHECK: rent refund.
    #[account(mut, address = trigger.owner)]
    pub owner: UncheckedAccount<'info>,
}

pub fn handle_cancel_trigger(ctx: Context<CancelTrigger>) -> Result<()> {
    authorize(&mut ctx.accounts.margin, &ctx.accounts.signer.key(), 0, 0, Clock::get()?.unix_timestamp)
}

#[derive(Accounts)]
pub struct ExecuteTrigger<'info> {
    pub keeper: Signer<'info>,
    #[account(mut, constraint = keeper_margin.owner == keeper.key() @ EngineError::NotAuthorized)]
    pub keeper_margin: Box<Account<'info, MarginAccount>>,
    #[account(mut, close = owner, has_one = margin)]
    pub trigger: Box<Account<'info, Trigger>>,
    #[account(mut)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(seeds = [seeds::MARKET, &trigger.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [seeds::FUNDING, &market.market_id.to_le_bytes()], bump = funding_state.bump)]
    pub funding_state: Box<Account<'info, FundingState>>,
    #[account(address = market.price_state @ EngineError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(mut, seeds = [seeds::SHARD, &market.market_id.to_le_bytes(), &[position.shard]], bump = shard.bump)]
    pub shard: Box<Account<'info, MarketShard>>,
    #[account(
        mut,
        seeds = [seeds::POSITION, margin.key().as_ref(), &market.market_id.to_le_bytes(), &[trigger.side.seed()]],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: rent refunds go to the margin owner.
    #[account(mut, address = margin.owner)]
    pub owner: UncheckedAccount<'info>,
}

/// Permissionless keepers run TP/SL through the same fill path; the owner pays
/// the fixed bounty shown when the trigger was placed.
pub fn handle_execute_trigger(mut ctx: Context<ExecuteTrigger>) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let t = &a.trigger;
    require!(clock.unix_timestamp <= t.expiry, EngineError::TriggerNotMet);
    let mark = mark_price(&a.price_state);
    let hit = match (t.side, t.kind) {
        (Side::Long, TriggerKind::TakeProfit) | (Side::Short, TriggerKind::StopLoss) => mark >= t.trigger_px,
        (Side::Long, TriggerKind::StopLoss) | (Side::Short, TriggerKind::TakeProfit) => mark <= t.trigger_px,
    };
    require!(hit, EngineError::TriggerNotMet);

    // slippage bound around the trigger price, against the exit direction
    let slip = t.trigger_px as i128 * t.max_slippage_bps as i128 / BPS as i128;
    let bound = match t.side {
        Side::Long => t.trigger_px - slip as i64,
        Side::Short => t.trigger_px + slip as i64,
    };
    let size = t.size.min(a.position.size);
    let bounty = t.keeper_bounty;

    let out = reduce(
        &a.market,
        &a.funding_state,
        &a.price_state,
        &mut a.margin,
        &mut a.position,
        &mut a.shard,
        size,
        Some(bound),
        ReduceKind::Trigger,
        &clock,
    )?;
    let paid = (bounty as i64).min(a.margin.collateral.max(0));
    a.margin.collateral -= paid;
    a.keeper_margin.collateral += paid;

    emit!(FillEvent {
        market_id: a.market.market_id,
        margin: a.margin.key(),
        side: a.position.side,
        is_open: false,
        size: out.size,
        price: out.fill.price,
        fee: out.fee,
        spread_paid: out.fill.spread_paid as u64,
        realized_pnl: out.realized,
        sample_hash: a.price_state.sample_hash,
        ts: clock.unix_timestamp,
    });
    if out.closed_all {
        a.position.close(a.owner.to_account_info())?;
    }
    Ok(())
}
