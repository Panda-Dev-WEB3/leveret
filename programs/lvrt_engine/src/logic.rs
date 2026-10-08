//! Engine core shared by open/close/trigger/liquidate/withdraw. Operates on
//! deserialized account structs so it stays independent of Anchor contexts.

use anchor_lang::prelude::*;
use lvrt_common::{
    lvrt_math::{
        fees, funding, margin as mm, pricing,
        pricing::{Fill, SpreadParams},
        notional, Side as MSide,
    },
    MathResultExt, PriceStatus, Session, Side,
};
use lvrt_oracle::PriceState;

use crate::{
    error::EngineError,
    state::{FundingState, MarginAccount, Market, MarketShard, Position},
};

pub const BORROW_PRECISION: i128 = 1_000_000;

pub fn now_ms(clock: &Clock) -> i64 {
    clock.unix_timestamp * 1_000 + 999
}

pub fn spread_params(market: &Market, session: Session) -> SpreadParams {
    let r = &market.risk;
    SpreadParams {
        base_bps: if session.is_off_hours() { r.off_hours_spread_bps } else { r.base_spread_bps } as i64,
        k_band_bps: r.k_band_bps as i64,
        skew_scale: r.skew_scale.max(1) as i64,
        max_premium_bps: r.max_premium_bps as i64,
    }
}

/// Quote for exits. CLOSED sessions trade at the last close; DELISTED settles
/// at the last verified price; WIDE closes pay an extra spread.
pub struct ExitQuote {
    pub mid: i64,
    pub bid: i64,
    pub ask: i64,
    pub extra_bps: i64,
}

pub fn exit_quote(market: &Market, ps: &PriceState, now_ms: i64) -> Result<ExitQuote> {
    match ps.status {
        PriceStatus::Halted | PriceStatus::CaPending => return err!(EngineError::MarketFrozen),
        _ => {}
    }
    if ps.status == PriceStatus::Delisted {
        return Ok(ExitQuote { mid: ps.mid, bid: ps.mid, ask: ps.mid, extra_bps: 0 });
    }
    if ps.session == Session::Closed {
        let c = if ps.last_close > 0 { ps.last_close } else { ps.mid };
        return Ok(ExitQuote { mid: c, bid: c, ask: c, extra_bps: 0 });
    }
    require!(now_ms - ps.ts_ms <= market.fresh_ms, EngineError::StalePrice);
    let extra = if ps.status == PriceStatus::Wide { market.risk.wide_spread_bps as i64 } else { 0 };
    Ok(ExitQuote { mid: ps.mid, bid: ps.bid, ask: ps.ask, extra_bps: extra })
}

/// Mark used for health checks (mid in session, last close when closed).
pub fn mark_price(ps: &PriceState) -> i64 {
    if ps.session == Session::Closed && ps.last_close > 0 {
        ps.last_close
    } else {
        ps.mid
    }
}

pub fn signed_size(pos: &Position) -> i64 {
    match pos.side {
        Side::Long => pos.size as i64,
        Side::Short => -(pos.size as i64),
    }
}

/// (funding owed, borrow owed) in USDC; positive = trader pays.
pub fn carry_owed(pos: &Position, fs: &FundingState) -> Result<(i64, i64)> {
    let f = funding::funding_owed(signed_size(pos), pos.entry_funding_index, fs.index).m()?;
    let d = fs.borrow_index.saturating_sub(pos.entry_borrow_index);
    let b = (pos.entry_notional as i128 * d / (BORROW_PRECISION * BORROW_PRECISION)) as i64;
    Ok((f, b.max(0)))
}

pub fn mm_bps(market: &Market, session: Session) -> i64 {
    if session.is_off_hours() {
        market.risk.mm_off_hours_bps as i64
    } else {
        market.risk.mm_bps as i64
    }
}

pub struct PositionHealth {
    pub upnl: i64,
    pub carry: i64,
    pub maintenance: i64,
    pub initial: i64,
}

pub fn position_health(pos: &Position, market: &Market, fs: &FundingState, ps: &PriceState) -> Result<PositionHealth> {
    let mark = mark_price(ps);
    let upnl = mm::unrealized_pnl(signed_size(pos), pos.entry_px, mark).m()?;
    let (f, b) = carry_owed(pos, fs)?;
    let n = notional(pos.size as i64, mark).m()?;
    let maintenance = mm::maintenance_margin(n, mm_bps(market, ps.session)).m()?;
    let lev = market.risk.max_lev_x100.max(100) as i64;
    let initial = mm::initial_margin(n, lev).m()?;
    Ok(PositionHealth { upnl, carry: f + b, maintenance, initial })
}

pub struct AccountHealth {
    pub equity: i64,
    pub maintenance: i64,
    pub initial: i64,
}

/// Cross-margin health. `rem` holds (Position, Market, FundingState,
/// PriceState) for **every** open position of `margin_key`; isolated
/// positions are validated but excluded from cross equity.
pub fn account_health<'info>(margin_key: &Pubkey, margin: &MarginAccount, rem: &'info [AccountInfo<'info>]) -> Result<AccountHealth> {
    require!(rem.len() == margin.open_positions as usize * 4, EngineError::HealthAccounts);
    let mut equity = margin.collateral;
    let mut maintenance = 0i64;
    let mut initial = 0i64;
    let mut seen: Vec<Pubkey> = Vec::with_capacity(margin.open_positions as usize);
    for chunk in rem.chunks(4) {
        let pos: Account<Position> = Account::try_from(&chunk[0])?;
        let market: Account<Market> = Account::try_from(&chunk[1])?;
        let fs: Account<FundingState> = Account::try_from(&chunk[2])?;
        let ps: Account<PriceState> = Account::try_from(&chunk[3])?;
        require_keys_eq!(pos.margin, *margin_key, EngineError::HealthAccounts);
        require!(!seen.contains(&chunk[0].key()), EngineError::HealthAccounts);
        seen.push(chunk[0].key());
        require!(pos.market_id == market.market_id && fs.market_id == market.market_id, EngineError::HealthAccounts);
        require_keys_eq!(market.price_state, chunk[3].key(), EngineError::WrongPriceState);
        if pos.isolated_margin > 0 {
            continue;
        }
        let h = position_health(&pos, &market, &fs, &ps)?;
        equity = equity.saturating_add(h.upnl).saturating_sub(h.carry);
        maintenance = maintenance.saturating_add(h.maintenance);
        initial = initial.saturating_add(h.initial);
    }
    Ok(AccountHealth { equity, maintenance, initial })
}

/// Bring a position's accrued funding/borrow into the ledger and reset its
/// indices (used before size changes). The amount is recorded on the shard
/// so `settle_shard` can move it between custody and the bucket.
pub fn settle_carry(pos: &mut Position, fs: &FundingState, margin: &mut MarginAccount, shard: &mut MarketShard) -> Result<i64> {
    let (f, b) = carry_owed(pos, fs)?;
    let owed = f + b;
    shard.carry_unsettled += owed;
    if pos.isolated_margin > 0 {
        let im = pos.isolated_margin as i64 - owed;
        pos.isolated_margin = im.max(0) as u64;
        if im < 0 {
            margin.collateral -= -im;
        }
    } else {
        margin.collateral -= owed;
    }
    pos.entry_funding_index = fs.index;
    pos.entry_borrow_index = fs.borrow_index;
    Ok(owed)
}

pub fn fee_for(market: &Market, margin: &MarginAccount, notional_abs: i64) -> Result<u64> {
    // $LVRT holding tier scales the market's base fee down (tier 0 = base,
    // top tier = 25/60 of base, i.e. 6 → 2.5 bps on Core)
    let tenth = (market.risk.fee_tenth_bps as i64 * fees::tier_fee_tenth_bps(margin.fee_tier) / 60).max(1);
    fees::trade_fee(notional_abs, tenth).m()
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ReduceKind {
    User,
    Trigger,
    Liquidation,
    /// Protocol-initiated close at the exact mark: no spread, fee or haircut.
    Adl,
}

pub struct ReduceOutcome {
    pub fill: Fill,
    pub size: u64,
    pub realized: i64,
    pub fee: u64,
    pub closed_all: bool,
}

/// Reduce `pos` by `size` at the exit quote. Exits always have a code path:
/// no pause/reduce-only/session gate applies here.
#[allow(clippy::too_many_arguments)]
pub fn reduce(
    market: &Market,
    fs: &FundingState,
    ps: &PriceState,
    margin: &mut MarginAccount,
    pos: &mut Position,
    shard: &mut MarketShard,
    size: u64,
    bound: Option<i64>,
    kind: ReduceKind,
    clock: &Clock,
) -> Result<ReduceOutcome> {
    require!(size > 0 && size <= pos.size, EngineError::InvalidParams);
    require!(pos.ca_epoch == market.ca.epoch, EngineError::CorporateActionPending);
    let q = exit_quote(market, ps, now_ms(clock))?;

    // closing a long sells (short-side fill) and vice versa
    let exit_side = match pos.side {
        Side::Long => MSide::Short,
        Side::Short => MSide::Long,
    };
    let fill = if kind == ReduceKind::Adl {
        Fill { price: q.mid, spread_bps: 0, spread_paid: 0 }
    } else {
        pricing::fill_price(
            exit_side,
            size as i64,
            q.mid,
            q.bid,
            q.ask,
            ps.band_bps,
            fs.skew(),
            &spread_params(market, ps.session),
            q.extra_bps,
        )
        .m()?
    };
    if let Some(b) = bound {
        require!(pricing::within_user_bound(exit_side, fill.price, b), EngineError::Slippage);
    }

    settle_carry(pos, fs, margin, shard)?;

    let ss = match pos.side {
        Side::Long => size as i64,
        Side::Short => -(size as i64),
    };
    let pnl = mm::unrealized_pnl(ss, pos.entry_px, fill.price).m()?;
    let held = clock.unix_timestamp - pos.opened_at;
    let spread_share = (pos.spread_paid as i128 * size as i128 / pos.size as i128) as i64;
    let protocol = matches!(kind, ReduceKind::Liquidation | ReduceKind::Adl);
    let realized = if protocol {
        pnl
    } else {
        mm::anti_stale_realized(pnl, spread_share + fill.spread_paid, held)
    };

    // circuit breaker on realized profit
    let mut pay_now = realized;
    if realized > 0 {
        if clock.unix_timestamp - margin.cb_window_start >= mm::CIRCUIT_BREAKER_WINDOW_S {
            margin.cb_window_start = clock.unix_timestamp;
            margin.cb_paid = 0;
        }
        let (now_part, queued) = mm::circuit_breaker_split(realized, margin.cb_paid);
        margin.cb_paid += now_part;
        if queued > 0 {
            margin.queued_profit += queued as u64;
            margin.queued_release_ts = clock.unix_timestamp + mm::CIRCUIT_BREAKER_DELAY_S;
        }
        pay_now = now_part;
    }

    let n_abs = notional(size as i64, fill.price).m()?.abs();
    let fee = if protocol { 0 } else { fee_for(market, margin, n_abs)? };

    let portion = |v: u64| -> u64 { (v as u128 * size as u128 / pos.size as u128) as u64 };
    let entry_portion = portion(pos.entry_notional);
    let im_portion = portion(pos.im_reserved);
    let iso_portion = portion(pos.isolated_margin);

    margin.collateral = margin.collateral + pay_now - fee as i64 + iso_portion as i64;
    margin.im_reserved = margin.im_reserved.saturating_sub(im_portion);

    let mut bad_debt = 0u64;
    if margin.collateral < 0 {
        bad_debt = (-margin.collateral) as u64;
        margin.collateral = 0;
    }

    match pos.side {
        Side::Long => {
            shard.oi_long = shard.oi_long.saturating_sub(size);
            shard.long_entry_notional = shard.long_entry_notional.saturating_sub(entry_portion);
        }
        Side::Short => {
            shard.oi_short = shard.oi_short.saturating_sub(size);
            shard.short_entry_notional = shard.short_entry_notional.saturating_sub(entry_portion);
        }
    }
    shard.fees_accrued += fee;
    shard.trader_pnl_unsettled += realized;
    shard.bad_debt += bad_debt;

    pos.size -= size;
    pos.entry_notional -= entry_portion;
    pos.im_reserved -= im_portion;
    pos.isolated_margin -= iso_portion;
    pos.spread_paid -= spread_share.max(0) as u64;
    let closed_all = pos.size == 0;
    if closed_all {
        margin.open_positions = margin.open_positions.saturating_sub(1);
    }
    Ok(ReduceOutcome { fill, size, realized, fee, closed_all })
}

/// Margin backing a position: its isolated margin, else the IM it reserved.
pub fn position_margin(pos: &Position) -> u64 {
    if pos.isolated_margin > 0 {
        pos.isolated_margin
    } else {
        pos.im_reserved
    }
}

pub fn usdc_notional(size: u64, px: i64) -> Result<u64> {
    Ok(notional(size as i64, px).m()?.unsigned_abs())
}
