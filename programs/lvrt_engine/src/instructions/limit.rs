//! Limit-open orders. Placing one moves its worst-case margin (initial margin
//! at the limit price + the max fee + the keeper bounty) out of free
//! collateral into the order, so a fill can always be paid for. A permissionless
//! keeper executes it through the same open fill path with the limit price as
//! the bound; cancel or expiry returns the reserve.

use anchor_lang::prelude::*;
use lvrt_common::{
    lvrt_math::{margin as mm, notional},
    seeds, MathResultExt, Side,
};
use lvrt_oracle::PriceState;

use crate::{
    error::EngineError,
    instructions::{
        account::{authorize, family_tool_bit},
        trade::{open_core, OpenAccounts, OpenArgs},
    },
    logic,
    state::{EngineConfig, FundingState, LimitOrder, MarginAccount, Market, MarketShard, Position},
};
use lvrt_common::lvrt_math::shard;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct LimitArgs {
    pub side: Side,
    /// Base units (1e6).
    pub size: u64,
    /// Long: buy at or below; short: sell at or above (1e8).
    pub limit_px: i64,
    pub leverage_x100: u32,
    /// 0 = cross.
    pub isolated_margin: u64,
    pub expiry: i64,
    pub keeper_bounty: u64,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct PlaceLimit<'info> {
    /// Owner or delegate; pays the order's rent (refunded to the keeper that fills it, or the owner on cancel).
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = signer,
        space = 8 + LimitOrder::INIT_SPACE,
        seeds = [seeds::LIMIT, margin.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub order: Box<Account<'info, LimitOrder>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_place_limit(mut ctx: Context<PlaceLimit>, nonce: u64, args: LimitArgs) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(args.size > 0 && args.limit_px > 0 && args.expiry > now && args.leverage_x100 >= 100, EngineError::InvalidParams);
    let a = &mut ctx.accounts;
    require!(args.leverage_x100 <= a.market.risk.max_lev_x100, EngineError::LeverageTooHigh);
    let n = notional(args.size as i64, args.limit_px).m()?.unsigned_abs();
    authorize(&mut a.margin, &a.signer.key(), family_tool_bit(a.market.family), n, now)?;

    let im = if args.isolated_margin > 0 {
        args.isolated_margin
    } else {
        mm::initial_margin(n as i64, args.leverage_x100 as i64).m()? as u64
    };
    let fee = logic::fee_for(&a.market, &a.margin, n as i64)?;
    let reserve = im + fee + args.keeper_bounty;
    let free = a.margin.collateral - a.margin.im_reserved as i64;
    require!(free >= reserve as i64, EngineError::InsufficientMargin);
    a.margin.collateral -= reserve as i64;

    let o = &mut a.order;
    o.margin = a.margin.key();
    o.owner = a.margin.owner;
    o.market_id = a.market.market_id;
    o.side = args.side;
    o.size = args.size;
    o.limit_px = args.limit_px;
    o.leverage_x100 = args.leverage_x100;
    o.isolated_margin = args.isolated_margin;
    o.expiry = args.expiry;
    o.keeper_bounty = args.keeper_bounty;
    o.reserved = reserve;
    o.nonce = nonce;
    o.bump = ctx.bumps.order;
    Ok(())
}

#[derive(Accounts)]
pub struct CancelLimit<'info> {
    pub signer: Signer<'info>,
    #[account(mut, address = order.margin)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(mut, close = owner)]
    pub order: Box<Account<'info, LimitOrder>>,
    /// CHECK: rent refund.
    #[account(mut, address = order.owner)]
    pub owner: UncheckedAccount<'info>,
}

/// Owner or delegate any time; anyone once the order has expired. The
/// reserve returns to free collateral.
pub fn handle_cancel_limit(mut ctx: Context<CancelLimit>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = &mut ctx.accounts;
    if now <= a.order.expiry {
        authorize(&mut a.margin, &a.signer.key(), 0, 0, now)?;
    }
    a.margin.collateral += a.order.reserved as i64;
    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteLimit<'info> {
    /// Pays the new position's rent; receives the order's rent and bounty.
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, constraint = keeper_margin.owner == keeper.key() @ EngineError::NotAuthorized)]
    pub keeper_margin: Box<Account<'info, MarginAccount>>,
    #[account(mut, close = keeper, has_one = margin)]
    pub order: Box<Account<'info, LimitOrder>>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, EngineConfig>>,
    #[account(mut)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(seeds = [seeds::MARKET, &order.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [seeds::FUNDING, &market.market_id.to_le_bytes()], bump = funding_state.bump)]
    pub funding_state: Box<Account<'info, FundingState>>,
    #[account(address = market.price_state @ EngineError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(
        mut,
        seeds = [seeds::SHARD, &market.market_id.to_le_bytes(), &[shard::shard_for(&margin.key().to_bytes(), market.shards)]],
        bump = shard.bump
    )]
    pub shard: Box<Account<'info, MarketShard>>,
    #[account(
        init_if_needed,
        payer = keeper,
        space = 8 + Position::INIT_SPACE,
        seeds = [seeds::POSITION, margin.key().as_ref(), &market.market_id.to_le_bytes(), &[order.side.seed()]],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: fills through the open path (fresh LIVE price, session,
/// leverage, caps) with the limit as the price bound, then pays the bounty.
pub fn handle_execute_limit(ctx: Context<ExecuteLimit>) -> Result<()> {
    let clock = Clock::get()?;
    let position_bump = ctx.bumps.position;
    let a = ctx.accounts;
    require!(clock.unix_timestamp <= a.order.expiry, EngineError::TriggerNotMet);
    let args = OpenArgs {
        side: a.order.side,
        size: a.order.size,
        price_bound: a.order.limit_px,
        leverage_x100: a.order.leverage_x100,
        isolated_margin: a.order.isolated_margin,
    };
    a.margin.collateral += a.order.reserved as i64;
    let margin_key = a.margin.key();
    open_core(
        OpenAccounts {
            config: &a.config,
            margin_key,
            margin: &mut a.margin,
            market: &a.market,
            funding_state: &a.funding_state,
            price_state: &a.price_state,
            shard: &mut a.shard,
            position: &mut a.position,
            position_bump,
        },
        args,
        None,
        &clock,
    )?; // a fill past the limit fails the bound: not executable yet
    let paid = (a.order.keeper_bounty as i64).min(a.margin.collateral.max(0));
    a.margin.collateral -= paid;
    a.keeper_margin.collateral += paid;
    Ok(())
}
