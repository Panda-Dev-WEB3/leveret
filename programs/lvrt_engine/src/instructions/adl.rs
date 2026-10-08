use anchor_lang::prelude::*;
use lvrt_common::{
    lvrt_math::{adl, margin as mm, BPS},
    seeds, MathResultExt, Side,
};
use lvrt_insurance::Fund;
use lvrt_oracle::PriceState;
use lvrt_vault::BucketState;

use crate::{
    error::EngineError,
    logic::{mark_price, position_margin, reduce, signed_size, ReduceKind},
    state::{AdlEvent, AdlReason, BucketRisk, EngineConfig, FundingState, MarginAccount, Market, MarketShard, Position},
};

/// Every market's merge must be this recent (~10 s) for the bucket view to count.
pub const MAX_MERGE_AGE_SLOTS: u64 = 25;
/// A round with no ADL for this long is over; the next one starts fresh.
pub const ADL_ROUND_TIMEOUT_S: i64 = 120;

#[derive(Accounts)]
pub struct AutoDeleverage<'info> {
    pub adl_operator: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = adl_operator @ EngineError::NotAdlOperator)]
    pub config: Box<Account<'info, EngineConfig>>,
    #[account(mut, seeds = [seeds::BUCKET_RISK, &[market.bucket.id()]], bump = bucket_risk.bump)]
    pub bucket_risk: Box<Account<'info, BucketRisk>>,
    #[account(
        seeds = [seeds::BUCKET, &[market.bucket.id()]],
        bump = bucket_state.bump,
        seeds::program = lvrt_vault::ID,
    )]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(
        seeds = [seeds::INSURANCE, &[market.bucket.id()]],
        bump = fund.bump,
        seeds::program = lvrt_insurance::ID,
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(mut, seeds = [seeds::FUNDING, &market.market_id.to_le_bytes()], bump = funding_state.bump)]
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
    #[account(mut)]
    pub margin: Box<Account<'info, MarginAccount>>,
    /// CHECK: receives the position's rent on full close.
    #[account(mut, address = margin.owner)]
    pub owner: UncheckedAccount<'info>,
}

fn shard_contribution(s: &MarketShard) -> i128 {
    -(s.trader_pnl_unsettled as i128) + s.carry_unsettled as i128 - s.bad_debt as i128
}

/// Backend §3.5, last step of the loss waterfall (position margin →
/// insurance → staked tranche → LLP NAV → ADL).
///
/// Allowed only while the bucket's trader uPnL ≥ `adl_trigger_bps` of its
/// capital (bucket USDC + unsettled flows + insurance fund), evaluated over
/// **every** market of the bucket: `remaining_accounts` = (Market,
/// FundingState, PriceState) × `bucket_risk.market_count`, each merged within
/// `MAX_MERGE_AGE_SLOTS`.
///
/// Closes just enough of one winning position, at the mark with no spread or
/// fee, to bring the ratio back to `adl_target_bps`. Targets are chosen by the
/// ADL operator by rank = `pnl% × leverage` (= PnL / margin); within a round
/// ranks must be non-increasing, and every step is logged with its rank and
/// reason so a skipped higher-ranked position is visible in receipts.
pub fn handle_auto_deleverage<'info>(mut ctx: Context<'info, AutoDeleverage<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    let rem = ctx.remaining_accounts;
    let a = &mut ctx.accounts;
    let bucket = a.market.bucket;

    // 1. bucket-wide liability (trader uPnL) and capital
    require!(rem.len() == a.bucket_risk.market_count as usize * 3, EngineError::AdlAccounts);
    let mut seen: Vec<u32> = Vec::with_capacity(a.bucket_risk.market_count as usize);
    let (mut liability, mut unsettled) = (0i128, 0i128);
    for chunk in rem.chunks(3) {
        let m: Account<Market> = Account::try_from(&chunk[0])?;
        let fs: Account<FundingState> = Account::try_from(&chunk[1])?;
        let ps: Account<PriceState> = Account::try_from(&chunk[2])?;
        require!(m.bucket == bucket && fs.market_id == m.market_id, EngineError::AdlAccounts);
        require_keys_eq!(chunk[2].key(), m.price_state, EngineError::AdlAccounts);
        require!(!seen.contains(&m.market_id), EngineError::AdlAccounts);
        seen.push(m.market_id);
        require!(fs.last_merge_slot + MAX_MERGE_AGE_SLOTS >= clock.slot, EngineError::StaleMerge);
        liability += adl::market_upnl(fs.oi_long, fs.oi_short, fs.long_entry_notional, fs.short_entry_notional, mark_price(&ps)).m()? as i128;
        unsettled += fs.unsettled_to_bucket as i128;
    }
    require!(seen.contains(&a.market.market_id), EngineError::AdlAccounts);
    let available = a.bucket_state.usdc_balance as i128 + unsettled + a.fund.balance as i128;
    let (l, av) = (to_i64(liability)?, to_i64(available)?);
    let (trigger, target) = (a.config.adl_trigger_bps, a.config.adl_target_bps);
    require!(adl::is_triggered(l, av, trigger), EngineError::AdlNotTriggered);
    let ratio_before = adl::pnl_ratio_bps(l, av);

    // 2. the target must be a winner; rank = return on its margin
    let mark = mark_price(&a.price_state);
    let pnl = mm::unrealized_pnl(signed_size(&a.position), a.position.entry_px, mark).m()?;
    require!(pnl > 0, EngineError::AdlNotProfitable);
    let rank = adl::rank(pnl, position_margin(&a.position)).m()?;

    // 3. ordering within a round
    let br = &mut a.bucket_risk;
    if !br.adl_active || clock.unix_timestamp - br.adl_last_ts > ADL_ROUND_TIMEOUT_S {
        br.adl_active = true;
        br.adl_round += 1;
        br.adl_last_rank = i128::MAX;
    }
    require!(rank <= br.adl_last_rank, EngineError::AdlRankOrder);

    // 4. close just enough to come back to the target
    let f_bps = adl::close_fraction_bps(l, av, pnl, target).m()?;
    require!(f_bps > 0, EngineError::AdlNotTriggered);
    let pos_size = a.position.size;
    let size = ((pos_size as u128 * f_bps as u128).div_ceil(BPS as u128) as u64).clamp(1, pos_size);

    let side = a.position.side;
    let entry_before = a.position.entry_notional;
    let contribution_before = shard_contribution(&a.shard);
    let out = reduce(
        &a.market,
        &a.funding_state,
        &a.price_state,
        &mut a.margin,
        &mut a.position,
        &mut a.shard,
        size,
        None,
        ReduceKind::Adl,
        &clock,
    )?;

    // keep the aggregate view exact until the next merge, so a follow-up ADL
    // in the same slot sees this one
    let delta = shard_contribution(&a.shard) - contribution_before;
    let delta = to_i64(delta)?;
    let entry_removed = entry_before - a.position.entry_notional;
    let fs = &mut a.funding_state;
    match side {
        Side::Long => {
            fs.oi_long = fs.oi_long.saturating_sub(out.size);
            fs.long_entry_notional = fs.long_entry_notional.saturating_sub(entry_removed);
        }
        Side::Short => {
            fs.oi_short = fs.oi_short.saturating_sub(out.size);
            fs.short_entry_notional = fs.short_entry_notional.saturating_sub(entry_removed);
        }
    }
    fs.unsettled_to_bucket += delta;
    a.shard.merged_to_bucket += delta;

    let ratio_after = adl::pnl_ratio_bps(l - out.realized, av + delta);
    let br = &mut a.bucket_risk;
    br.adl_last_rank = rank;
    br.adl_last_ts = clock.unix_timestamp;
    if ratio_after <= target as i64 {
        br.adl_active = false;
    }

    emit!(AdlEvent {
        market_id: a.market.market_id,
        margin: a.margin.key(),
        side,
        size: out.size,
        price: out.fill.price,
        realized_pnl: out.realized,
        rank,
        round: br.adl_round,
        ratio_before_bps: ratio_before,
        ratio_after_bps: ratio_after,
        reason: AdlReason::BucketPnlRatio,
    });
    if out.closed_all {
        a.position.close(a.owner.to_account_info())?;
    }
    Ok(())
}

fn to_i64(v: i128) -> Result<i64> {
    i64::try_from(v).map_err(|_| error!(EngineError::InvalidParams))
}
