use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};
use lvrt_common::{assert_upgrade_authority, seeds, Bucket, Family, USDC_MINT};
use lvrt_oracle::PriceState;

use crate::{
    error::EngineError,
    state::{BucketRisk, CaKind, CorporateAction, EngineConfig, FundingConfig, FundingState, Market, RiskParams, MAX_CUSTODY},
};

// ---------------------------------------------------------------- initialize

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + EngineConfig::INIT_SPACE, seeds = [seeds::CONFIG], bump)]
    pub config: Account<'info, EngineConfig>,
    /// CHECK: engine signer PDA (custody owner); only its bump is stored.
    #[account(seeds = [seeds::AUTHORITY], bump)]
    pub engine_signer: UncheckedAccount<'info>,
    #[account(address = USDC_MINT @ EngineError::NotUsdc)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    /// CHECK: this program, for the upgrade-authority check.
    #[account(address = crate::ID)]
    pub program: UncheckedAccount<'info>,
    /// CHECK: checked in `assert_upgrade_authority`.
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey, ca_operator: Pubkey, custody_count: u8) -> Result<()> {
    assert_upgrade_authority(&ctx.accounts.program, &ctx.accounts.program_data, &ctx.accounts.payer.key())?;
    require!(custody_count >= 1 && custody_count <= MAX_CUSTODY, EngineError::InvalidParams);
    let c = &mut ctx.accounts.config;
    c.authority = authority;
    c.guardian = guardian;
    c.ca_operator = ca_operator;
    c.usdc_mint = ctx.accounts.usdc_mint.key();
    c.custody_count = custody_count;
    c.opens_paused = false;
    c.adl_operator = Pubkey::default();
    c.adl_trigger_bps = lvrt_common::lvrt_math::adl::DEFAULT_TRIGGER_BPS;
    c.adl_target_bps = lvrt_common::lvrt_math::adl::DEFAULT_TARGET_BPS;
    c.signer_bump = ctx.bumps.engine_signer;
    c.bump = ctx.bumps.config;
    Ok(())
}

#[derive(Accounts)]
#[instruction(k: u8)]
pub struct InitCustody<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, EngineConfig>,
    /// CHECK: engine signer PDA.
    #[account(seeds = [seeds::AUTHORITY], bump = config.signer_bump)]
    pub engine_signer: UncheckedAccount<'info>,
    #[account(address = config.usdc_mint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [seeds::CUSTODY, &[k]],
        bump,
        token::mint = usdc_mint,
        token::authority = engine_signer,
        token::token_program = token_program,
    )]
    pub custody: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: custody accounts are deterministic PDAs owned by the engine.
pub fn handle_init_custody(ctx: Context<InitCustody>, k: u8) -> Result<()> {
    require!(k < ctx.accounts.config.custody_count, EngineError::InvalidParams);
    Ok(())
}

// ------------------------------------------------------------------- markets

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct MarketParams {
    pub market_id: u32,
    pub family: Family,
    pub bucket: Bucket,
    pub fresh_ms: i64,
    pub risk: RiskParams,
    pub funding: FundingConfig,
    pub shards: u8,
    pub guarded: bool,
}

pub fn validate_risk(r: &RiskParams) -> Result<()> {
    require!(r.max_lev_x100 >= 100 && r.off_hours_lev_x100 <= r.max_lev_x100, EngineError::InvalidParams);
    // maintenance must be strictly below initial margin at max leverage
    require!((r.mm_bps as u64) * (r.max_lev_x100 as u64) < 1_000_000, EngineError::InvalidParams);
    require!(r.mm_off_hours_bps >= r.mm_bps, EngineError::InvalidParams);
    require!(r.band_ref_bps <= r.band_limit_bps && r.skew_scale > 0, EngineError::InvalidParams);
    Ok(())
}

#[derive(Accounts)]
#[instruction(params: MarketParams)]
pub struct CreateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub authority: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = authority @ EngineError::NotAuthority)]
    pub config: Account<'info, EngineConfig>,
    #[account(init, payer = payer, space = 8 + Market::INIT_SPACE, seeds = [seeds::MARKET, &params.market_id.to_le_bytes()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = payer, space = 8 + FundingState::INIT_SPACE, seeds = [seeds::FUNDING, &params.market_id.to_le_bytes()], bump)]
    pub funding_state: Account<'info, FundingState>,
    #[account(
        seeds = [seeds::PRICE, &params.market_id.to_le_bytes()],
        bump = price_state.bump,
        seeds::program = lvrt_oracle::ID,
    )]
    pub price_state: Account<'info, PriceState>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + BucketRisk::INIT_SPACE,
        seeds = [seeds::BUCKET_RISK, &[params.bucket.id()]],
        bump
    )]
    pub bucket_risk: Account<'info, BucketRisk>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_market(ctx: Context<CreateMarket>, p: MarketParams) -> Result<()> {
    validate_risk(&p.risk)?;
    require!(p.shards >= 1 && p.shards <= lvrt_common::lvrt_math::shard::MAX_SHARDS, EngineError::InvalidParams);
    require!(ctx.accounts.price_state.family == p.family, EngineError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let m = &mut ctx.accounts.market;
    m.market_id = p.market_id;
    m.family = p.family;
    m.bucket = p.bucket;
    m.price_state = ctx.accounts.price_state.key();
    m.fresh_ms = p.fresh_ms;
    m.risk = p.risk;
    m.funding = p.funding;
    m.shards = p.shards;
    m.reduce_only = false;
    m.guarded = p.guarded;
    m.listed_at = now;
    m.ca = CorporateAction { epoch: 0, kind: CaKind::None, ratio_num: 1, ratio_den: 1, dividend: 0, effective_ts: 0 };
    m.bump = ctx.bumps.market;
    let f = &mut ctx.accounts.funding_state;
    f.market_id = p.market_id;
    f.last_update = now;
    f.bump = ctx.bumps.funding_state;
    let br = &mut ctx.accounts.bucket_risk;
    if br.market_count == 0 {
        br.bucket = p.bucket;
        br.bump = ctx.bumps.bucket_risk;
    }
    br.market_count += 1;
    Ok(())
}

#[derive(Accounts)]
pub struct SetMarket<'info> {
    pub signer: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, EngineConfig>,
    #[account(mut, seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

/// Every field must move in the safe direction for the guardian.
fn is_tighter(o: &RiskParams, n: &RiskParams) -> bool {
    n.max_lev_x100 <= o.max_lev_x100
        && n.off_hours_lev_x100 <= o.off_hours_lev_x100
        && n.mm_bps >= o.mm_bps
        && n.mm_off_hours_bps >= o.mm_off_hours_bps
        && n.oi_cap_long <= o.oi_cap_long
        && n.oi_cap_short <= o.oi_cap_short
        && n.max_position_notional <= o.max_position_notional
        && n.base_spread_bps >= o.base_spread_bps
        && n.off_hours_spread_bps >= o.off_hours_spread_bps
        && n.wide_spread_bps >= o.wide_spread_bps
        && n.k_band_bps >= o.k_band_bps
        && n.band_limit_bps <= o.band_limit_bps
        && n.band_ref_bps <= o.band_ref_bps
        && n.skew_scale == o.skew_scale
        && n.max_premium_bps == o.max_premium_bps
        && n.fee_tenth_bps == o.fee_tenth_bps
        && n.liq_bounty_cap == o.liq_bounty_cap
}

pub fn handle_set_market_risk(ctx: Context<SetMarket>, risk: RiskParams, funding: Option<FundingConfig>) -> Result<()> {
    validate_risk(&risk)?;
    let s = ctx.accounts.signer.key();
    let c = &ctx.accounts.config;
    let m = &mut ctx.accounts.market;
    if s != c.authority {
        require_keys_eq!(s, c.guardian, EngineError::NotAuthorityOrGuardian);
        require!(is_tighter(&m.risk, &risk) && funding.is_none(), EngineError::GuardianCannotLoosen);
    }
    m.risk = risk;
    if let Some(f) = funding {
        m.funding = f;
    }
    Ok(())
}

/// reduce_only / guarded: guardian may only switch them on.
pub fn handle_set_market_flags(ctx: Context<SetMarket>, reduce_only: bool, guarded: bool) -> Result<()> {
    let s = ctx.accounts.signer.key();
    let c = &ctx.accounts.config;
    let m = &mut ctx.accounts.market;
    if s != c.authority {
        require_keys_eq!(s, c.guardian, EngineError::NotAuthorityOrGuardian);
        require!(reduce_only >= m.reduce_only && guarded >= m.guarded, EngineError::GuardianCannotLoosen);
    }
    m.reduce_only = reduce_only;
    m.guarded = guarded;
    Ok(())
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Account<'info, EngineConfig>,
}

/// Guardian can pause; only the timelock can unpause.
pub fn handle_set_opens_paused(ctx: Context<SetConfig>, paused: bool) -> Result<()> {
    let s = ctx.accounts.signer.key();
    let c = &mut ctx.accounts.config;
    if s != c.authority {
        require_keys_eq!(s, c.guardian, EngineError::NotAuthorityOrGuardian);
        require!(paused, EngineError::GuardianCannotLoosen);
    }
    c.opens_paused = paused;
    Ok(())
}

/// Timelock only. `trigger` must exceed `target`, and both stay below 100%
/// so ADL acts before the bucket can no longer pay winners.
pub fn handle_set_adl_params(ctx: Context<SetConfig>, operator: Pubkey, trigger_bps: u16, target_bps: u16) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require_keys_eq!(ctx.accounts.signer.key(), c.authority, EngineError::NotAuthority);
    require!(target_bps > 0 && target_bps < trigger_bps && trigger_bps < 10_000, EngineError::InvalidParams);
    c.adl_operator = operator;
    c.adl_trigger_bps = trigger_bps;
    c.adl_target_bps = target_bps;
    Ok(())
}

pub fn handle_set_roles(ctx: Context<SetConfig>, guardian: Pubkey, ca_operator: Pubkey) -> Result<()> {
    let c = &mut ctx.accounts.config;
    require_keys_eq!(ctx.accounts.signer.key(), c.authority, EngineError::NotAuthority);
    c.guardian = guardian;
    c.ca_operator = ca_operator;
    Ok(())
}

// --------------------------------------------------------- corporate actions

#[derive(Accounts)]
pub struct DeclareCorporateAction<'info> {
    pub ca_operator: Signer<'info>,
    #[account(seeds = [seeds::CONFIG], bump = config.bump, has_one = ca_operator @ EngineError::NotAuthorized)]
    pub config: Account<'info, EngineConfig>,
    #[account(mut, seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(address = market.price_state @ EngineError::WrongPriceState)]
    pub price_state: Account<'info, PriceState>,
}

/// Declared at the effective time while the oracle holds the market in
/// CA_PENDING; positions are then rescaled by `apply_corporate_action` before
/// the first fresh post-split print reopens the market.
pub fn handle_declare_corporate_action(ctx: Context<DeclareCorporateAction>, kind: CaKind, ratio_num: u32, ratio_den: u32, dividend: i64) -> Result<()> {
    require!(ctx.accounts.price_state.status == lvrt_common::PriceStatus::CaPending, EngineError::MarketFrozen);
    match kind {
        CaKind::Split => require!(ratio_num > 0 && ratio_den > 0, EngineError::InvalidParams),
        CaKind::Dividend => require!(dividend > 0, EngineError::InvalidParams),
        CaKind::None => return err!(EngineError::InvalidParams),
    }
    let m = &mut ctx.accounts.market;
    m.ca = CorporateAction {
        epoch: m.ca.epoch + 1,
        kind,
        ratio_num,
        ratio_den,
        dividend,
        effective_ts: Clock::get()?.unix_timestamp,
    };
    Ok(())
}
