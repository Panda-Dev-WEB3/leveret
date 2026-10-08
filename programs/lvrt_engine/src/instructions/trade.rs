use anchor_lang::prelude::*;
use lvrt_common::{
    lvrt_math::{margin as mm, pricing, risk, shard, notional},
    seeds, MathResultExt, PriceStatus, Side,
};
use lvrt_oracle::PriceState;

use crate::{
    error::EngineError,
    instructions::account::{authorize, family_tool_bit},
    logic::{self, now_ms, reduce, settle_carry, spread_params, ReduceKind},
    state::{EngineConfig, FillEvent, FundingState, MarginAccount, Market, MarketShard, Position, MAX_POSITIONS_PER_ACCOUNT},
};

// ---------------------------------------------------------------- init shard

#[derive(Accounts)]
#[instruction(k: u8)]
pub struct InitShard<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        init,
        payer = payer,
        space = 8 + MarketShard::INIT_SPACE,
        seeds = [seeds::SHARD, &market.market_id.to_le_bytes(), &[k]],
        bump
    )]
    pub shard: Box<Account<'info, MarketShard>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_shard(ctx: Context<InitShard>, k: u8) -> Result<()> {
    require!(k < ctx.accounts.market.shards, EngineError::InvalidParams);
    let s = &mut ctx.accounts.shard;
    s.market_id = ctx.accounts.market.market_id;
    s.index = k;
    s.bump = ctx.bumps.shard;
    Ok(())
}

// ---------------------------------------------------------------------- open

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct OpenArgs {
    pub side: Side,
    /// Base units (1e6).
    pub size: u64,
    /// Long: max fill price; short: min fill price.
    pub price_bound: i64,
    pub leverage_x100: u32,
    /// 0 = cross; otherwise USDC moved from the ledger into the position.
    pub isolated_margin: u64,
}

#[derive(Accounts)]
#[instruction(args: OpenArgs)]
pub struct OpenPosition<'info> {
    /// Owner or delegate; pays rent for a new position account.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, EngineConfig>>,
    #[account(mut)]
    pub margin: Box<Account<'info, MarginAccount>>,
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
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
        payer = signer,
        space = 8 + Position::INIT_SPACE,
        seeds = [seeds::POSITION, margin.key().as_ref(), &market.market_id.to_le_bytes(), &[args.side.seed()]],
        bump
    )]
    pub position: Box<Account<'info, Position>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_position(mut ctx: Context<OpenPosition>, args: OpenArgs) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    let a = &mut ctx.accounts;
    let market = &a.market;
    let ps = &a.price_state;
    let fs = &a.funding_state;
    require!(args.size > 0, EngineError::InvalidParams);

    // 1–2. fresh verified price, LIVE, session allows the family, band inside limit
    require!(!a.config.opens_paused, EngineError::OpensPaused);
    require!(!market.reduce_only, EngineError::ReduceOnly);
    require!(ps.status == PriceStatus::Live, EngineError::PriceNotLive);
    require!(now_ms(&clock) - ps.ts_ms <= market.fresh_ms, EngineError::StalePrice);
    require!(ps.band_bps <= market.risk.band_limit_bps, EngineError::BandTooWide);
    let off_lev = market.risk.off_hours_lev_x100 as i64;
    require!(risk::opens_allowed(market.family.math(), ps.session.math(), off_lev), EngineError::SessionClosed);
    require!(a.position.size == 0 || a.position.ca_epoch == market.ca.epoch, EngineError::CorporateActionPending);

    // 3. fill price: max(ask, mid·(1+spread)) / min(bid, mid·(1−spread)) with skew premium
    let fill = pricing::fill_price(
        args.side.math(),
        args.size as i64,
        ps.mid,
        ps.bid,
        ps.ask,
        ps.band_bps,
        fs.skew(),
        &spread_params(market, ps.session),
        0,
    )
    .m()?;
    // 4. user bound
    require!(pricing::within_user_bound(args.side.math(), fill.price, args.price_bound), EngineError::Slippage);

    // 5. leverage ≤ min(market, class(band), session)
    let class_lev = risk::class_lev_for_band(
        market.risk.max_lev_x100 as i64,
        ps.band_bps,
        market.risk.band_ref_bps,
        market.risk.band_limit_bps,
    );
    let max_lev = risk::effective_max_lev(market.risk.max_lev_x100 as i64, class_lev, ps.session.math(), off_lev);
    require!((args.leverage_x100 as i64) <= max_lev, EngineError::LeverageTooHigh);

    let n = notional(args.size as i64, fill.price).m()?.unsigned_abs();
    authorize(&mut a.margin, &a.signer.key(), family_tool_bit(market.family), n, now)?;

    // OI cap (conservative between merges) and per-account limit; guarded = half caps
    let (agg, delta, cap) = match args.side {
        Side::Long => (fs.oi_long, a.shard.delta_long_since_merge, market.risk.oi_cap_long),
        Side::Short => (fs.oi_short, a.shard.delta_short_since_merge, market.risk.oi_cap_short),
    };
    let cap = risk::guarded_cap(cap as i64, market.guarded);
    let bound = shard::oi_upper_bound(agg as i64, delta as i64, market.shards).m()?;
    require!(bound + args.size as i64 <= cap, EngineError::OiCap);
    let pos_cap = risk::guarded_cap(market.risk.max_position_notional as i64, market.guarded) as u64;
    require!(a.position.entry_notional + n <= pos_cap, EngineError::PositionLimit);

    // margin after fee
    let fee = logic::fee_for(market, &a.margin, n as i64)?;
    let im = mm::initial_margin(n as i64, args.leverage_x100 as i64).m()? as u64;
    let is_new = a.position.size == 0;
    if is_new {
        require!(a.margin.open_positions < MAX_POSITIONS_PER_ACCOUNT, EngineError::TooManyPositions);
    } else {
        require!((a.position.isolated_margin > 0) == (args.isolated_margin > 0), EngineError::InvalidParams);
        settle_carry(&mut a.position, fs, &mut a.margin, &mut a.shard)?;
    }
    let m = &mut a.margin;
    if args.isolated_margin > 0 {
        require!(args.isolated_margin >= im, EngineError::InsufficientMargin);
        require!(m.collateral >= (args.isolated_margin + fee) as i64, EngineError::InsufficientMargin);
        m.collateral -= (args.isolated_margin + fee) as i64;
    } else {
        let free = m.collateral - m.im_reserved as i64 - fee as i64;
        require!(free >= im as i64, EngineError::InsufficientMargin);
        m.collateral -= fee as i64;
        m.im_reserved += im;
    }

    // 6. write Position, MarginAccount, MarketShard
    let p = &mut a.position;
    if is_new {
        p.margin = m.key();
        p.market_id = market.market_id;
        p.side = args.side;
        p.entry_funding_index = fs.index;
        p.entry_borrow_index = fs.borrow_index;
        p.ca_epoch = market.ca.epoch;
        p.shard = a.shard.index;
        p.bump = ctx.bumps.position;
        m.open_positions += 1;
    }
    let new_size = p.size + args.size;
    p.entry_notional += n;
    p.entry_px = (p.entry_notional as i128 * lvrt_common::lvrt_math::PRICE_SCALE as i128 / new_size as i128) as i64;
    p.size = new_size;
    p.opened_at = now;
    p.spread_paid = fill.spread_paid as u64;
    if args.isolated_margin > 0 {
        p.isolated_margin += args.isolated_margin;
    } else {
        p.im_reserved += im;
    }

    let s = &mut a.shard;
    match args.side {
        Side::Long => {
            s.oi_long += args.size;
            s.long_entry_notional += n;
            s.delta_long_since_merge += args.size;
        }
        Side::Short => {
            s.oi_short += args.size;
            s.short_entry_notional += n;
            s.delta_short_since_merge += args.size;
        }
    }
    s.fees_accrued += fee;

    emit!(FillEvent {
        market_id: market.market_id,
        margin: m.key(),
        side: args.side,
        is_open: true,
        size: args.size,
        price: fill.price,
        fee,
        spread_paid: fill.spread_paid as u64,
        realized_pnl: 0,
        sample_hash: ps.sample_hash,
        ts: now,
    });
    Ok(())
}

// --------------------------------------------------------------------- close

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub signer: Signer<'info>,
    #[account(mut)]
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
    /// CHECK: receives the position account's rent on full close.
    #[account(mut, address = margin.owner)]
    pub owner: UncheckedAccount<'info>,
}

/// Exits are never blocked by a pause, reduce-only, WIDE or a closed session.
pub fn handle_close_position(mut ctx: Context<ClosePosition>, size: u64, price_bound: i64) -> Result<()> {
    let clock = Clock::get()?;
    let a = &mut ctx.accounts;
    let size = if size == 0 { a.position.size } else { size };
    let n = logic::usdc_notional(size, a.price_state.mid)?;
    authorize(&mut a.margin, &a.signer.key(), family_tool_bit(a.market.family), n, clock.unix_timestamp)?;
    let out = reduce(
        &a.market,
        &a.funding_state,
        &a.price_state,
        &mut a.margin,
        &mut a.position,
        &mut a.shard,
        size,
        Some(price_bound),
        ReduceKind::User,
        &clock,
    )?;
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
