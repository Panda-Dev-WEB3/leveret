use anchor_lang::prelude::*;
use lvrt_common::{
    lvrt_math::{
        corporate::{self, Ratio},
        funding::{self, FundingParams},
        BPS,
    },
    seeds, MathResultExt, Session,
};
use lvrt_oracle::PriceState;

use crate::{
    error::EngineError,
    logic::{signed_size, BORROW_PRECISION},
    state::{CaKind, FundingMerged, FundingState, MarginAccount, Market, MarketShard, Position},
};

// -------------------------------------------------------------- merge shards

#[derive(Accounts)]
pub struct MergeShards<'info> {
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [seeds::FUNDING, &market.market_id.to_le_bytes()], bump = funding_state.bump)]
    pub funding_state: Box<Account<'info, FundingState>>,
    #[account(address = market.price_state @ EngineError::WrongPriceState)]
    pub price_state: Box<Account<'info, PriceState>>,
}

/// Permissionless, every slot (merge-cranker): sum shard OI, reset the
/// since-merge deltas, advance funding (velocity model) and borrow.
/// `remaining_accounts`: all `market.shards` shard accounts, writable.
pub fn handle_merge_shards<'info>(ctx: Context<'info, MergeShards<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let market = &ctx.accounts.market;
    let rem = ctx.remaining_accounts;
    require!(rem.len() == market.shards as usize, EngineError::InvalidParams);

    let (mut ol, mut os, mut nl, mut ns) = (0u64, 0u64, 0u64, 0u64);
    let mut seen = 0u64;
    for ai in rem.iter() {
        let mut s: Account<MarketShard> = Account::try_from(ai)?;
        require!(s.market_id == market.market_id && (s.index as u32) < 64, EngineError::InvalidParams);
        require!(seen & (1 << s.index) == 0, EngineError::InvalidParams);
        seen |= 1 << s.index;
        ol += s.oi_long;
        os += s.oi_short;
        nl += s.long_entry_notional;
        ns += s.short_entry_notional;
        s.delta_long_since_merge = 0;
        s.delta_short_since_merge = 0;
        s.exit(&crate::ID)?;
    }

    let ps = &ctx.accounts.price_state;
    let fs = &mut ctx.accounts.funding_state;
    let dt = (clock.unix_timestamp - fs.last_update).max(0);
    if dt > 0 && ps.mid > 0 {
        let in_session = ps.session == Session::Regular || market.family == lvrt_common::Family::Core;
        let p = FundingParams {
            max_velocity: market.funding.max_velocity as i128,
            skew_scale: market.risk.skew_scale.max(1) as i64,
            max_rate: market.funding.max_rate as i128,
            imbalance_k: market.funding.imbalance_k as i128,
        };
        let skew = ol as i64 - os as i64;
        let u = funding::accrue_funding(fs.rate, fs.index, skew, ol as i64, os as i64, ps.mid, dt, in_session, &p).m()?;
        fs.rate = u.rate;
        fs.index = u.index;

        // borrow on open notional, both sides, from utilization of the OI caps
        let cap = (market.risk.oi_cap_long + market.risk.oi_cap_short).max(1) as i128;
        let util_bps = ((ol + os) as i128 * BPS as i128 / cap).min(BPS as i128) as i64;
        let rate_ppm_h = funding::borrow_rate(market.funding.borrow_base_ppm as i64, market.funding.borrow_slope_ppm as i64, util_bps).m()?;
        fs.borrow_index += rate_ppm_h as i128 * dt as i128 * BORROW_PRECISION / 3_600;
        fs.last_update = clock.unix_timestamp;
    }
    fs.oi_long = ol;
    fs.oi_short = os;
    fs.long_entry_notional = nl;
    fs.short_entry_notional = ns;
    fs.last_merge_slot = clock.slot;
    emit!(FundingMerged { market_id: market.market_id, rate: fs.rate, index: fs.index, oi_long: ol, oi_short: os, slot: clock.slot });
    Ok(())
}

// --------------------------------------------------------- corporate actions

#[derive(Accounts)]
pub struct ApplyCorporateAction<'info> {
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, constraint = position.market_id == market.market_id @ EngineError::InvalidParams)]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, address = position.margin)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(mut, seeds = [seeds::SHARD, &market.market_id.to_le_bytes(), &[position.shard]], bump = shard.bump)]
    pub shard: Box<Account<'info, MarketShard>>,
}

/// Permissionless crank (§3.6): split k → size × k, entry_px / k (notional
/// unchanged; shard OI rescaled in step); dividend D → longs credited D × size,
/// shorts debited the same.
/// TODO(engine): rescale open Trigger prices / k as well, and gate the
/// market's reopen on "every position migrated" (count per epoch).
pub fn handle_apply_corporate_action(ctx: Context<ApplyCorporateAction>) -> Result<()> {
    let ca = ctx.accounts.market.ca;
    let p = &mut ctx.accounts.position;
    require!(p.ca_epoch + 1 == ca.epoch, EngineError::Noop);
    match ca.kind {
        CaKind::Split => {
            let k = Ratio { num: ca.ratio_num, den: ca.ratio_den };
            let new_size = corporate::split_size(p.size as i64, k).m()? as u64;
            let s = &mut ctx.accounts.shard;
            match p.side {
                lvrt_common::Side::Long => s.oi_long = s.oi_long - p.size + new_size,
                lvrt_common::Side::Short => s.oi_short = s.oi_short - p.size + new_size,
            }
            p.size = new_size;
            p.entry_px = corporate::split_price(p.entry_px, k).m()?;
        }
        CaKind::Dividend => {
            let adj = corporate::dividend_adjustment(signed_size(p), ca.dividend).m()?;
            ctx.accounts.margin.collateral += adj;
            ctx.accounts.shard.trader_pnl_unsettled += adj;
        }
        CaKind::None => {}
    }
    p.ca_epoch = ca.epoch;
    Ok(())
}

// ------------------------------------------------------------------- settle

#[derive(Accounts)]
pub struct SettleShard<'info> {
    #[account(mut)]
    pub shard: Box<Account<'info, MarketShard>>,
}

/// TODO(engine): move `fees_accrued` to the fee router and net
/// `trader_pnl_unsettled` between engine custody and the market's LLP bucket
/// (CPI into lvrt_vault::settle_from_engine, signed by the engine signer
/// PDA), routing `bad_debt` through lvrt_insurance first.
pub fn handle_settle_shard(_ctx: Context<SettleShard>) -> Result<()> {
    err!(EngineError::NotImplemented)
}
