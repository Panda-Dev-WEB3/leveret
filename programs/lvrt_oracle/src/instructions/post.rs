use anchor_lang::prelude::*;
use lvrt_common::{
    hashv, ix_sysvar,
    lvrt_math::oracle::{self as agg, source, AggState, Sample},
    seeds,
    sigverify::{verified_messages, PriceMsg},
    Family, PriceStatus, Session,
};

use crate::{
    error::OracleError,
    state::{Calendar, Feed, PriceState, PriceUpdated, SignerKey},
};

/// Gap protocol after a halt resumes: band ≥ 2× normal for 10 minutes.
pub const GAP_PROTOCOL_MS: i64 = 10 * 60 * 1_000;

#[derive(Accounts)]
pub struct PostPrices<'info> {
    #[account(seeds = [seeds::FEED, &feed.market_id.to_le_bytes()], bump = feed.bump)]
    pub feed: Account<'info, Feed>,
    #[account(
        mut,
        seeds = [seeds::PRICE, &feed.market_id.to_le_bytes()],
        bump = price_state.bump,
        constraint = price_state.market_id == feed.market_id @ OracleError::WrongMarket
    )]
    pub price_state: Account<'info, PriceState>,
    #[account(seeds = [seeds::CALENDAR], bump = calendar.bump)]
    pub calendar: Account<'info, Calendar>,
    /// CHECK: address-checked instructions sysvar.
    #[account(address = ix_sysvar::ID)]
    pub instructions: UncheckedAccount<'info>,
}

fn session_from_u8(v: u8) -> Session {
    match v {
        0 => Session::Regular,
        1 => Session::Pre,
        2 => Session::Post,
        3 => Session::Overnight,
        _ => Session::Closed,
    }
}

pub fn handle_post_prices<'info>(ctx: Context<'info, PostPrices<'info>>) -> Result<()> {
    let clock = Clock::get()?;
    // Clock has 1s resolution; treat "now" as the end of the current second.
    let now_ms = clock.unix_timestamp * 1_000 + 999;
    let feed = &ctx.accounts.feed;
    let msgs = verified_messages(&ctx.accounts.instructions.to_account_info())?;

    let mut samples: Vec<Sample> = Vec::with_capacity(4);
    let mut seen: u8 = 0;
    let mut halted = false;
    let mut session: Option<Session> = None;
    let mut enclave_band: u16 = 0;
    let mut raw: Vec<&[u8]> = Vec::with_capacity(4);

    for ai in ctx.remaining_accounts.iter() {
        let key: Account<SignerKey> = Account::try_from(ai)?;
        require!(key.active && key.valid_until > clock.unix_timestamp, OracleError::UnknownSigner);
        require!(feed.allowed_sources & (1 << key.source) != 0, OracleError::SourceNotAllowed);
        if seen & (1 << key.source) != 0 {
            continue; // one sample per source
        }
        // One transaction may carry reports for several markets from the same
        // signer: use the one for this feed's market.
        let found = msgs
            .iter()
            .filter(|sm| sm.signer == key.pubkey)
            .find_map(|sm| PriceMsg::decode(&sm.message).ok().filter(|m| m.market_id == feed.market_id).map(|m| (sm, m)));
        let Some((sm, m)) = found else { continue };
        seen |= 1 << key.source;
        halted |= m.halted;
        if key.source == source::CHAINLINK || key.source == source::ENCLAVE || session.is_none() {
            session = Some(session_from_u8(m.session));
        }
        if key.source == source::ENCLAVE {
            enclave_band = m.band_bps;
        }
        samples.push(Sample { source: key.source, mid: m.mid, bid: m.bid, ask: m.ask, ts_ms: m.ts_ms });
        raw.push(&sm.message);
    }
    require!(!samples.is_empty(), OracleError::Stale);

    let a = match feed.family {
        Family::Core => agg::aggregate_median(&samples, now_ms, feed.fresh_ms, feed.max_dev_bps as i64, feed.min_sources as usize),
        Family::Stocks => {
            let primary = samples.iter().find(|s| s.source == source::CHAINLINK).ok_or(OracleError::SourceNotAllowed)?;
            let secondary = samples.iter().find(|s| s.source != source::CHAINLINK);
            agg::aggregate_primary_confirmed(primary, secondary, now_ms, feed.fresh_ms, feed.max_dev_bps as i64)
        }
        // Small Caps and Factors: enclave output only (it medians ≥ 3 licensed feeds).
        _ => {
            let e = samples.iter().find(|s| s.source == source::ENCLAVE).ok_or(OracleError::SourceNotAllowed)?;
            agg::aggregate_median(core::slice::from_ref(e), now_ms, feed.fresh_ms, i64::MAX, 1)
        }
    }
    .map_err(|_| error!(OracleError::Stale))?;

    let ps = &mut ctx.accounts.price_state;
    if a.ts_ms <= ps.ts_ms {
        // Someone already posted a fresher price this slot; keep it.
        return Ok(());
    }

    let mut session = if feed.family == Family::Core { Session::Regular } else { session.unwrap_or(Session::Closed) };
    if feed.family != Family::Core && ctx.accounts.calendar.forces_closed(a.ts_ms) {
        session = Session::Closed;
    }

    let mut band = a.band_bps.max(enclave_band);
    let prev_status = ps.status;
    let prev_session = ps.session;

    let mut status = if halted {
        PriceStatus::Halted
    } else if matches!(prev_status, PriceStatus::CaPending | PriceStatus::Delisted) {
        prev_status // cleared only by set_status / the corporate-action crank
    } else if a.state == AggState::Wide || band > feed.band_limit_bps {
        PriceStatus::Wide
    } else {
        PriceStatus::Live
    };

    // Gap protocol only on a real resume; a new listing starts HALTED with no price.
    if prev_status == PriceStatus::Halted && !halted && ps.ts_ms > 0 {
        ps.gap_until_ms = a.ts_ms + GAP_PROTOCOL_MS;
    }
    if a.ts_ms < ps.gap_until_ms {
        band = band.max(feed.normal_band_bps.saturating_mul(2));
        if band > feed.band_limit_bps && status == PriceStatus::Live {
            status = PriceStatus::Wide;
        }
    }

    ps.at_open = (prev_session == Session::Closed || prev_status == PriceStatus::Halted) && session != Session::Closed;
    ps.mid = a.mid;
    ps.bid = a.bid;
    ps.ask = a.ask;
    ps.band_bps = band;
    ps.ts_ms = a.ts_ms;
    ps.slot = clock.slot;
    ps.session = session;
    ps.status = status;
    ps.source_mask = a.source_mask;
    ps.sample_hash = hashv(&raw).to_bytes();
    if session == Session::Regular {
        ps.last_close = a.mid;
    }

    emit!(PriceUpdated {
        market_id: ps.market_id,
        mid: ps.mid,
        bid: ps.bid,
        ask: ps.ask,
        band_bps: ps.band_bps,
        ts_ms: ps.ts_ms,
        status: ps.status,
        session: ps.session,
        source_mask: ps.source_mask,
        sample_hash: ps.sample_hash,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct PostExternalReport<'info> {
    #[account(seeds = [seeds::FEED, &feed.market_id.to_le_bytes()], bump = feed.bump)]
    pub feed: Account<'info, Feed>,
    #[account(mut, seeds = [seeds::PRICE, &feed.market_id.to_le_bytes()], bump = price_state.bump)]
    pub price_state: Account<'info, PriceState>,
    #[account(seeds = [seeds::CALENDAR], bump = calendar.bump)]
    pub calendar: Account<'info, Calendar>,
    /// CHECK: upstream verifier program, address-checked once wired.
    pub verifier_program: UncheckedAccount<'info>,
}

/// TODO(oracle): CPI into the Chainlink Data Streams verifier with `report`
/// (or a pre-posted buffer account when it exceeds the v0 tx size), decode
/// bid/ask/mid/market-status/staleness into a `Sample`, then share the
/// aggregation path with `post_prices`. Until then Chainlink data enters
/// through a registered Pusher key signing the decoded `PriceMsg`.
pub fn handle_post_chainlink_report(_ctx: Context<PostExternalReport>, _report: Vec<u8>) -> Result<()> {
    err!(OracleError::VerifierNotWired)
}

/// TODO(oracle): verify a Switchboard Surge signed update via its on-demand
/// quote verification (instruction introspection; exact layout is (U)).
pub fn handle_post_switchboard_update(_ctx: Context<PostExternalReport>, _update: Vec<u8>) -> Result<()> {
    err!(OracleError::VerifierNotWired)
}
