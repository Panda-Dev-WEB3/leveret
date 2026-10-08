use anchor_lang::prelude::*;
use lvrt_common::{
    lvrt_math::{margin as mm, notional, BPS},
    seeds, MathResultExt,
};
use lvrt_oracle::PriceState;

use crate::{
    error::EngineError,
    logic::{account_health, position_health, reduce, ReduceKind},
    state::{FundingState, LiquidationEvent, MarginAccount, Market, MarketShard, Position},
};

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,
    /// Liquidator's own margin account receives the bounty (ledger credit).
    #[account(mut, constraint = liquidator_margin.owner == liquidator.key() @ EngineError::NotAuthorized)]
    pub liquidator_margin: Box<Account<'info, MarginAccount>>,
    #[account(mut, constraint = margin.key() != liquidator_margin.key() @ EngineError::InvalidParams)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [seeds::FUNDING, &market.market_id.to_le_bytes()], bump = funding_state.bump)]
    pub funding_state: Box<Account<'info, FundingState>>,
    #[account(address = market.price_state @ EngineError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
    #[account(mut, seeds = [seeds::SHARD, &market.market_id.to_le_bytes(), &[position.shard]], bump = shard.bump)]
    pub shard: Box<Account<'info, MarketShard>>,
    #[account(
        mut,
        seeds = [seeds::POSITION, margin.key().as_ref(), &market.market_id.to_le_bytes(), &[position.side.seed()]],
        bump = position.bump,
        has_one = margin,
    )]
    pub position: Box<Account<'info, Position>>,
    /// CHECK: receives rent on full close.
    #[account(mut, address = margin.owner)]
    pub owner: UncheckedAccount<'info>,
}

/// Permissionless (§3.5). Isolated positions use their own margin; cross
/// positions need (Position, Market, FundingState, PriceState) for every open
/// position in `remaining_accounts`. Closes 25% per call, 100% below half of
/// maintenance. Off-hours, Stocks are marked at the held last close, so they
/// can only be liquidated on margin drawdown (fees, funding, borrow).
pub fn handle_liquidate<'info>(mut ctx: Context<'info, Liquidate<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let margin_key = ctx.accounts.margin.key();
    let a = &mut ctx.accounts;

    let (equity, maintenance) = if a.position.isolated_margin > 0 {
        let h = position_health(&a.position, &a.market, &a.funding_state, &a.price_state)?;
        (a.position.isolated_margin as i64 + h.upnl - h.carry, h.maintenance)
    } else {
        let h = account_health(&margin_key, &a.margin, ctx.remaining_accounts)?;
        (h.equity, h.maintenance)
    };
    require!(mm::is_liquidatable(equity, maintenance), EngineError::NotLiquidatable);

    let close_bps = mm::liquidation_close_bps(equity, maintenance);
    let mut size = (a.position.size as u128 * close_bps as u128 / BPS as u128) as u64;
    if size == 0 || close_bps == BPS {
        size = a.position.size;
    }

    let out = reduce(
        &a.market,
        &a.funding_state,
        &a.price_state,
        &mut a.margin,
        &mut a.position,
        &mut a.shard,
        size,
        None,
        ReduceKind::Liquidation,
        &clock,
    )?;

    // Bounty: 0.5–1.5% of closed notional, capped, from what the account has left.
    let closed_notional = notional(out.size as i64, out.fill.price).m()?.abs();
    let bounty = mm::liquidation_bounty(closed_notional, equity, maintenance, a.market.risk.liq_bounty_cap as i64)
        .m()?
        .min(a.margin.collateral.max(0)) as u64;
    a.margin.collateral -= bounty as i64;
    a.liquidator_margin.collateral += bounty as i64;

    emit!(LiquidationEvent {
        market_id: a.market.market_id,
        margin: margin_key,
        liquidator: a.liquidator.key(),
        side: a.position.side,
        size: out.size,
        price: out.fill.price,
        bounty,
        bad_debt: a.shard.bad_debt,
        sample_hash: a.price_state.sample_hash,
    });
    if out.closed_all {
        a.position.close(a.owner.to_account_info())?;
    }
    Ok(())
}
