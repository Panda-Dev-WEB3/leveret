use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use lvrt_common::{
    lvrt_math::{
        corporate::{self, Ratio},
        funding::{self, FundingParams},
        BPS,
    },
    seeds, MathResultExt, Session,
};
use lvrt_insurance::Fund;
use lvrt_oracle::PriceState;
use lvrt_vault::BucketState;

use crate::{
    error::EngineError,
    logic::{signed_size, BORROW_PRECISION},
    state::{CaKind, EngineConfig, FundingMerged, FundingState, MarginAccount, Market, MarketShard, Position, ShardSettled},
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
            let m = &mut ctx.accounts.margin;
            let s = &mut ctx.accounts.shard;
            m.collateral += adj;
            s.trader_pnl_unsettled += adj;
            // a short's dividend debit can exceed its collateral
            if m.collateral < 0 {
                s.bad_debt += (-m.collateral) as u64;
                m.collateral = 0;
            }
        }
        CaKind::None => {}
    }
    p.ca_epoch = ca.epoch;
    Ok(())
}

// ------------------------------------------------------------------- settle

#[derive(Accounts)]
#[instruction(custody_index: u8)]
pub struct SettleShard<'info> {
    #[account(seeds = [seeds::CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, EngineConfig>>,
    /// CHECK: engine signer PDA; signs custody transfers and the vault /
    /// insurance CPIs.
    #[account(seeds = [seeds::AUTHORITY], bump = config.signer_bump)]
    pub engine_signer: UncheckedAccount<'info>,
    #[account(seeds = [seeds::MARKET, &market.market_id.to_le_bytes()], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        seeds = [seeds::SHARD, &market.market_id.to_le_bytes(), &[shard.index]],
        bump = shard.bump
    )]
    pub shard: Box<Account<'info, MarketShard>>,
    #[account(address = config.usdc_mint @ EngineError::NotUsdc)]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Any custody shard; the cranker picks one that can cover the outflow.
    #[account(mut, seeds = [seeds::CUSTODY, &[custody_index]], bump)]
    pub custody: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [seeds::FEE_INBOX, &[market.bucket.id()]],
        bump,
        seeds::program = lvrt_fee_router::ID,
    )]
    pub fee_inbox: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: owner + seeds checked by lvrt_vault in the CPI.
    pub vault_config: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [seeds::BUCKET, &[market.bucket.id()]],
        bump = bucket_state.bump,
        seeds::program = lvrt_vault::ID,
    )]
    pub bucket_state: Box<Account<'info, BucketState>>,
    #[account(mut, address = bucket_state.usdc_vault)]
    pub bucket_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: owner + seeds checked by lvrt_insurance in the CPI.
    pub insurance_config: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [seeds::INSURANCE, &[market.bucket.id()]],
        bump = fund.bump,
        seeds::program = lvrt_insurance::ID,
    )]
    pub fund: Box<Account<'info, Fund>>,
    #[account(mut, address = fund.usdc_vault)]
    pub insurance_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: CPI target.
    #[account(address = lvrt_vault::ID)]
    pub vault_program: UncheckedAccount<'info>,
    /// CHECK: CPI target.
    #[account(address = lvrt_insurance::ID)]
    pub insurance_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

fn pay_from_custody<'info>(a: &SettleShard<'info>, to: AccountInfo<'info>, amount: u64) -> Result<()> {
    let bump = a.config.signer_bump;
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            a.token_program.key(),
            TransferChecked {
                from: a.custody.to_account_info(),
                mint: a.usdc_mint.to_account_info(),
                to,
                authority: a.engine_signer.to_account_info(),
            },
            &[&[seeds::AUTHORITY, &[bump]]],
        ),
        amount,
        a.usdc_mint.decimals,
    )
}

/// Permissionless crank: move what the shard's ledger already says happened.
/// Trades only touch internal balances; this is where USDC actually moves.
///
/// - custody → fee router inbox: `fees_accrued`
/// - custody ↔ LLP bucket: `−trader_pnl + carry − bad_debt` (traders' net
///   losses and carry actually collected, or their net gains paid out)
/// - insurance → bucket: `min(bad_debt, fund)`; the rest is left for the
///   staked tranche (TODO: slashing) and otherwise reduces LLP NAV
///
/// Afterwards custody holds exactly Σ trader collateral + queued profit.
pub fn handle_settle_shard<'info>(ctx: Context<'info, SettleShard<'info>>, _custody_index: u8) -> Result<()> {
    let a = &ctx.accounts;
    let s = &a.shard;
    let fees = s.fees_accrued;
    let net = -(s.trader_pnl_unsettled as i128) + s.carry_unsettled as i128 - s.bad_debt as i128;
    require!(fees > 0 || net != 0 || s.bad_debt > 0, EngineError::Noop);
    let to_bucket = i64::try_from(net).map_err(|_| EngineError::InvalidParams)?;
    let covered = s.bad_debt.min(a.fund.balance);
    let uncovered = s.bad_debt - covered;

    let outflow = fees as u128 + to_bucket.max(0) as u128;
    require!(a.custody.amount as u128 >= outflow, EngineError::InsufficientCustody);

    let bump = a.config.signer_bump;
    let signer: &[&[&[u8]]] = &[&[seeds::AUTHORITY, &[bump]]];
    if fees > 0 {
        pay_from_custody(a, a.fee_inbox.to_account_info(), fees)?;
    }
    if to_bucket > 0 {
        pay_from_custody(a, a.bucket_vault.to_account_info(), to_bucket as u64)?;
    }
    if covered > 0 {
        lvrt_insurance::cpi::cover_shortfall(
            CpiContext::new_with_signer(
                lvrt_insurance::ID,
                lvrt_insurance::cpi::accounts::CoverShortfall {
                    engine_signer: a.engine_signer.to_account_info(),
                    config: a.insurance_config.to_account_info(),
                    fund: a.fund.to_account_info(),
                    usdc_mint: a.usdc_mint.to_account_info(),
                    usdc_vault: a.insurance_vault.to_account_info(),
                    destination: a.bucket_vault.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                },
                signer,
            ),
            covered,
        )?;
    }
    let incoming = to_bucket.max(0) as u64 + covered;
    let outgoing = (-to_bucket).max(0) as u64;
    if incoming > 0 || outgoing > 0 {
        // records `incoming` (already transferred) and pays `outgoing` to custody
        lvrt_vault::cpi::settle_from_engine(
            CpiContext::new_with_signer(
                lvrt_vault::ID,
                lvrt_vault::cpi::accounts::SettleFromEngine {
                    engine_signer: a.engine_signer.to_account_info(),
                    config: a.vault_config.to_account_info(),
                    bucket_state: a.bucket_state.to_account_info(),
                    usdc_mint: a.usdc_mint.to_account_info(),
                    usdc_vault: a.bucket_vault.to_account_info(),
                    engine_custody: a.custody.to_account_info(),
                    usdc_token_program: a.token_program.to_account_info(),
                },
                signer,
            ),
            incoming,
            outgoing,
        )?;
    }

    let market_id = a.market.market_id;
    let s = &mut ctx.accounts.shard;
    s.fees_accrued = 0;
    s.trader_pnl_unsettled = 0;
    s.carry_unsettled = 0;
    s.bad_debt = 0;
    emit!(ShardSettled { market_id, shard: s.index, fees, to_bucket, insurance_covered: covered, uncovered });
    Ok(())
}
