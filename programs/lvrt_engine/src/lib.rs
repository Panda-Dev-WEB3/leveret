//! lvrt_engine — margin, sharded positions, one-transaction fills, funding,
//! liquidation (Backend §3).
//!
//! Design rules enforced here:
//! 1. no fill without a fresh, verified price whose band is inside the limit;
//! 2. leverage / OI / spread are functions of class and live band;
//! 3. a pause blocks entries only: close, reduce, liquidate and withdraw
//!    never check it;
//! 5. USDC is the only collateral.

use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod logic;
pub mod state;

pub use instructions::*;
pub use state::*;

declare_id!("DDwLPMgoXWAnCpDHYp1jSNg5bzW2mAJTvioqZHhyE3gD");

#[program]
pub mod lvrt_engine {
    use super::*;

    // ---- admin (timelock / guardian / ca-operator)

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey, ca_operator: Pubkey, custody_count: u8) -> Result<()> {
        instructions::admin::handle_initialize(ctx, authority, guardian, ca_operator, custody_count)
    }

    pub fn init_custody(ctx: Context<InitCustody>, k: u8) -> Result<()> {
        instructions::admin::handle_init_custody(ctx, k)
    }

    pub fn create_market(ctx: Context<CreateMarket>, params: MarketParams) -> Result<()> {
        instructions::admin::handle_create_market(ctx, params)
    }

    pub fn set_market_risk(ctx: Context<SetMarket>, risk: RiskParams, funding: Option<FundingConfig>) -> Result<()> {
        instructions::admin::handle_set_market_risk(ctx, risk, funding)
    }

    pub fn set_market_flags(ctx: Context<SetMarket>, reduce_only: bool, guarded: bool) -> Result<()> {
        instructions::admin::handle_set_market_flags(ctx, reduce_only, guarded)
    }

    pub fn set_opens_paused(ctx: Context<SetConfig>, paused: bool) -> Result<()> {
        instructions::admin::handle_set_opens_paused(ctx, paused)
    }

    pub fn set_roles(ctx: Context<SetConfig>, guardian: Pubkey, ca_operator: Pubkey) -> Result<()> {
        instructions::admin::handle_set_roles(ctx, guardian, ca_operator)
    }

    pub fn declare_corporate_action(ctx: Context<DeclareCorporateAction>, kind: CaKind, ratio_num: u32, ratio_den: u32, dividend: i64) -> Result<()> {
        instructions::admin::handle_declare_corporate_action(ctx, kind, ratio_num, ratio_den, dividend)
    }

    // ---- accounts and collateral

    pub fn create_margin_account(ctx: Context<CreateMarginAccount>, sub_id: u8) -> Result<()> {
        instructions::account::handle_create_margin_account(ctx, sub_id)
    }

    pub fn set_delegate(ctx: Context<OwnerOnly>, slot: u8, delegate: Delegate) -> Result<()> {
        instructions::account::handle_set_delegate(ctx, slot, delegate)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::account::handle_deposit(ctx, amount)
    }

    pub fn deposit_usdt(ctx: Context<OwnerOnly>, amount: u64) -> Result<()> {
        instructions::account::handle_deposit_usdt(ctx, amount)
    }

    pub fn withdraw<'info>(ctx: Context<'info, Withdraw<'info>>, amount: u64, custody_index: u8) -> Result<()> {
        instructions::account::handle_withdraw(ctx, amount, custody_index)
    }

    pub fn claim_queued_profit(ctx: Context<OwnerOnly>) -> Result<()> {
        instructions::account::handle_claim_queued_profit(ctx)
    }

    // ---- trading

    pub fn init_shard(ctx: Context<InitShard>, k: u8) -> Result<()> {
        instructions::trade::handle_init_shard(ctx, k)
    }

    pub fn open_position(ctx: Context<OpenPosition>, args: OpenArgs) -> Result<()> {
        instructions::trade::handle_open_position(ctx, args)
    }

    pub fn close_position(ctx: Context<ClosePosition>, size: u64, price_bound: i64) -> Result<()> {
        instructions::trade::handle_close_position(ctx, size, price_bound)
    }

    pub fn place_trigger(ctx: Context<PlaceTrigger>, nonce: u64, args: TriggerArgs) -> Result<()> {
        instructions::trigger::handle_place_trigger(ctx, nonce, args)
    }

    pub fn cancel_trigger(ctx: Context<CancelTrigger>) -> Result<()> {
        instructions::trigger::handle_cancel_trigger(ctx)
    }

    pub fn execute_trigger(ctx: Context<ExecuteTrigger>) -> Result<()> {
        instructions::trigger::handle_execute_trigger(ctx)
    }

    // ---- risk

    pub fn liquidate<'info>(ctx: Context<'info, Liquidate<'info>>) -> Result<()> {
        instructions::liquidate::handle_liquidate(ctx)
    }

    pub fn auto_deleverage(ctx: Context<Liquidate>) -> Result<()> {
        instructions::liquidate::handle_auto_deleverage(ctx)
    }

    // ---- cranks

    pub fn merge_shards<'info>(ctx: Context<'info, MergeShards<'info>>) -> Result<()> {
        instructions::crank::handle_merge_shards(ctx)
    }

    pub fn apply_corporate_action(ctx: Context<ApplyCorporateAction>) -> Result<()> {
        instructions::crank::handle_apply_corporate_action(ctx)
    }

    /// Move fees, net trader PnL, carry and insurance cover for one shard.
    pub fn settle_shard<'info>(ctx: Context<'info, SettleShard<'info>>, custody_index: u8) -> Result<()> {
        instructions::crank::handle_settle_shard(ctx, custody_index)
    }
}
