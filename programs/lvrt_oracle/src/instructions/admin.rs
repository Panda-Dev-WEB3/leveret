use anchor_lang::prelude::*;
use lvrt_common::{assert_upgrade_authority, seeds, Family, PriceStatus, Session};

use crate::{
    error::OracleError,
    state::{Calendar, Feed, OracleConfig, PriceState, SignerKey, SignerKind, StatusChanged, MAX_HOLIDAYS},
};

// ---------------------------------------------------------------- initialize

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + OracleConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, OracleConfig>,
    #[account(init, payer = payer, space = 8 + Calendar::INIT_SPACE, seeds = [seeds::CALENDAR], bump)]
    pub calendar: Account<'info, Calendar>,
    /// CHECK: this program, for the upgrade-authority check.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey) -> Result<()> {
    assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
    let c = &mut ctx.accounts.config;
    c.authority = authority;
    c.guardian = guardian;
    c.bump = ctx.bumps.config;
    ctx.accounts.calendar.bump = ctx.bumps.calendar;
    Ok(())
}

// ------------------------------------------------------------------- signers

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct SignerParams {
    pub pubkey: Pubkey,
    pub kind: SignerKind,
    pub source: u8,
    pub attestation_hash: [u8; 32],
    pub tcb_level: u16,
    pub valid_until: i64,
}

#[derive(Accounts)]
#[instruction(params: SignerParams)]
pub struct RegisterSigner<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ OracleError::NotAuthority)]
    pub config: Account<'info, OracleConfig>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SignerKey::INIT_SPACE,
        seeds = [seeds::SIGNER, params.pubkey.as_ref()],
        bump
    )]
    pub signer_key: Account<'info, SignerKey>,
    pub system_program: Program<'info, System>,
}

/// Registers or rotates a key (enclave keys rotate every 24h with a fresh
/// attestation; the quote is published off-chain for anyone to re-verify).
pub fn handle_register_signer(ctx: Context<RegisterSigner>, p: SignerParams) -> Result<()> {
    require!(p.source < 8, OracleError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    require!(p.valid_until > now, OracleError::InvalidParams);
    let k = &mut ctx.accounts.signer_key;
    k.pubkey = p.pubkey;
    k.kind = p.kind;
    k.source = p.source;
    k.attestation_hash = p.attestation_hash;
    k.tcb_level = p.tcb_level;
    k.valid_until = p.valid_until;
    k.active = true;
    k.bump = ctx.bumps.signer_key;
    Ok(())
}

#[derive(Accounts)]
pub struct RevokeSigner<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, OracleConfig>,
    #[account(mut, seeds = [seeds::SIGNER, signer_key.pubkey.as_ref()], bump = signer_key.bump)]
    pub signer_key: Account<'info, SignerKey>,
}

pub fn handle_revoke_signer(ctx: Context<RevokeSigner>) -> Result<()> {
    let s = ctx.accounts.signer.key();
    let c = &ctx.accounts.config;
    require!(s == c.authority || s == c.guardian, OracleError::NotAuthorityOrGuardian);
    ctx.accounts.signer_key.active = false;
    Ok(())
}

// --------------------------------------------------------------------- feeds

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct FeedParams {
    pub market_id: u32,
    pub family: Family,
    pub symbol: [u8; 16],
    pub allowed_sources: u8,
    pub min_sources: u8,
    pub max_dev_bps: u16,
    pub fresh_ms: i64,
    pub band_limit_bps: u16,
    pub normal_band_bps: u16,
    pub chainlink_feed_id: [u8; 32],
    pub switchboard_feed_id: [u8; 32],
    pub min_source_depth_usd: u64,
    /// Depth of the shallowest source's underlying as measured by the listing
    /// script; recorded in the proposal and checked here.
    pub measured_source_depth_usd: u64,
}

impl FeedParams {
    fn validate(&self) -> Result<()> {
        require!(self.allowed_sources != 0 && self.min_sources >= 1, OracleError::InvalidParams);
        require!(self.max_dev_bps > 0 && self.fresh_ms > 0, OracleError::InvalidParams);
        require!(self.band_limit_bps >= self.normal_band_bps, OracleError::InvalidParams);
        // ≥ 2 independent sources for every new market (Overview §4); Small
        // Caps / Factors are a single enclave that medians ≥ 3 feeds inside.
        let independent = self.allowed_sources.count_ones() as u8;
        match self.family {
            Family::Core | Family::Stocks => require!(independent >= 2, OracleError::InvalidParams),
            _ => {}
        }
        require!(self.measured_source_depth_usd >= self.min_source_depth_usd, OracleError::DepthGate);
        Ok(())
    }

    fn write(&self, f: &mut Feed) {
        f.market_id = self.market_id;
        f.family = self.family;
        f.symbol = self.symbol;
        f.allowed_sources = self.allowed_sources;
        f.min_sources = self.min_sources;
        f.max_dev_bps = self.max_dev_bps;
        f.fresh_ms = self.fresh_ms;
        f.band_limit_bps = self.band_limit_bps;
        f.normal_band_bps = self.normal_band_bps;
        f.chainlink_feed_id = self.chainlink_feed_id;
        f.switchboard_feed_id = self.switchboard_feed_id;
        f.min_source_depth_usd = self.min_source_depth_usd;
    }
}

#[derive(Accounts)]
#[instruction(params: FeedParams)]
pub struct CreateFeed<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ OracleError::NotAuthority)]
    pub config: Account<'info, OracleConfig>,
    #[account(init, payer = payer, space = 8 + Feed::INIT_SPACE, seeds = [seeds::FEED, &params.market_id.to_le_bytes()], bump)]
    pub feed: Account<'info, Feed>,
    #[account(init, payer = payer, space = 8 + PriceState::INIT_SPACE, seeds = [seeds::PRICE, &params.market_id.to_le_bytes()], bump)]
    pub price_state: Account<'info, PriceState>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_feed(ctx: Context<CreateFeed>, p: FeedParams) -> Result<()> {
    p.validate()?;
    let f = &mut ctx.accounts.feed;
    p.write(f);
    f.bump = ctx.bumps.feed;
    let ps = &mut ctx.accounts.price_state;
    ps.market_id = p.market_id;
    ps.family = p.family;
    // No price until the first verified update.
    ps.status = PriceStatus::Halted;
    ps.session = if p.family == Family::Core { Session::Regular } else { Session::Closed };
    ps.bump = ctx.bumps.price_state;
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateFeed<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ OracleError::NotAuthority)]
    pub config: Account<'info, OracleConfig>,
    #[account(mut, seeds = [seeds::FEED, &feed.market_id.to_le_bytes()], bump = feed.bump)]
    pub feed: Account<'info, Feed>,
}

pub fn handle_update_feed(ctx: Context<UpdateFeed>, p: FeedParams) -> Result<()> {
    require!(p.market_id == ctx.accounts.feed.market_id && p.family == ctx.accounts.feed.family, OracleError::InvalidParams);
    p.validate()?;
    p.write(&mut ctx.accounts.feed);
    Ok(())
}

// -------------------------------------------------------------------- status

#[derive(Accounts)]
pub struct SetStatus<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, OracleConfig>,
    #[account(mut, seeds = [seeds::PRICE, &price_state.market_id.to_le_bytes()], bump = price_state.bump)]
    pub price_state: Account<'info, PriceState>,
}

fn restrictiveness(s: PriceStatus) -> u8 {
    match s {
        PriceStatus::Live => 0,
        PriceStatus::Wide => 1,
        PriceStatus::CaPending => 2,
        PriceStatus::Halted => 3,
        PriceStatus::Delisted => 4,
    }
}

pub fn handle_set_status(ctx: Context<SetStatus>, status: PriceStatus) -> Result<()> {
    let s = ctx.accounts.signer.key();
    let c = &ctx.accounts.config;
    let ps = &mut ctx.accounts.price_state;
    let from = ps.status;
    if s != c.authority {
        require_keys_eq!(s, c.guardian, OracleError::NotAuthorityOrGuardian);
        require!(restrictiveness(status) >= restrictiveness(from), OracleError::GuardianCannotLoosen);
    }
    ps.status = status;
    emit!(StatusChanged { market_id: ps.market_id, from, to: status, by: s });
    Ok(())
}

// ------------------------------------------------------------------ calendar

#[derive(Accounts)]
pub struct SetCalendar<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ OracleError::NotAuthority)]
    pub config: Account<'info, OracleConfig>,
    #[account(mut, seeds = [seeds::CALENDAR], bump = calendar.bump)]
    pub calendar: Account<'info, Calendar>,
}

pub fn handle_set_calendar(ctx: Context<SetCalendar>, holidays: Vec<u32>) -> Result<()> {
    require!(holidays.len() <= MAX_HOLIDAYS && holidays.windows(2).all(|w| w[0] < w[1]), OracleError::BadCalendar);
    ctx.accounts.calendar.holidays = holidays;
    Ok(())
}
