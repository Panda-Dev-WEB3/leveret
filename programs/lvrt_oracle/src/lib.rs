//! lvrt_oracle — verify + aggregate (Backend §2).
//!
//! A user transaction is `[Ed25519 verify ix(s)] [lvrt_oracle::post_prices]
//! [lvrt_engine::open/close/...]`: the signed price travels inside the
//! transaction and is checked on-chain, so there is no request-then-keeper
//! wait. The oracle-pusher service posts the same way for markets with no
//! recent trade.

use anchor_lang::prelude::*;

pub mod error;
pub mod instructions;
pub mod state;

pub use instructions::*;
pub use state::*;

declare_id!("CFG1eAfxM49c4wAtL2xuorZkH1SB1cHdG8gJyGQUo2P8");

#[program]
pub mod lvrt_oracle {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey, guardian: Pubkey) -> Result<()> {
        instructions::admin::handle_initialize(ctx, authority, guardian)
    }

    pub fn register_signer(ctx: Context<RegisterSigner>, params: SignerParams) -> Result<()> {
        instructions::admin::handle_register_signer(ctx, params)
    }

    /// Authority or guardian (revoking is tightening).
    pub fn revoke_signer(ctx: Context<RevokeSigner>) -> Result<()> {
        instructions::admin::handle_revoke_signer(ctx)
    }

    pub fn create_feed(ctx: Context<CreateFeed>, params: FeedParams) -> Result<()> {
        instructions::admin::handle_create_feed(ctx, params)
    }

    pub fn update_feed(ctx: Context<UpdateFeed>, params: FeedParams) -> Result<()> {
        instructions::admin::handle_update_feed(ctx, params)
    }

    /// HALTED / CA_PENDING / DELISTED transitions. The guardian may only move
    /// a market to a more restrictive status.
    pub fn set_status(ctx: Context<SetStatus>, status: lvrt_common::PriceStatus) -> Result<()> {
        instructions::admin::handle_set_status(ctx, status)
    }

    pub fn set_calendar(ctx: Context<SetCalendar>, holidays: Vec<u32>) -> Result<()> {
        instructions::admin::handle_set_calendar(ctx, holidays)
    }

    /// Aggregate Ed25519-signed `PriceMsg`s from registered signers.
    /// `remaining_accounts`: the `SignerKey` PDA of every contributing signer.
    pub fn post_prices<'info>(ctx: Context<'info, PostPrices<'info>>) -> Result<()> {
        instructions::post::handle_post_prices(ctx)
    }

    /// Chainlink Data Streams report verified by CPI into the verifier program.
    pub fn post_chainlink_report(ctx: Context<PostExternalReport>, report: Vec<u8>) -> Result<()> {
        instructions::post::handle_post_chainlink_report(ctx, report)
    }

    /// Switchboard Surge update verified via its on-demand quote program.
    pub fn post_switchboard_update(ctx: Context<PostExternalReport>, update: Vec<u8>) -> Result<()> {
        instructions::post::handle_post_switchboard_update(ctx, update)
    }

    pub fn post_receipt_root(ctx: Context<PostReceiptRoot>, hour: u64, root: [u8; 32], leaf_count: u64) -> Result<()> {
        instructions::receipts::handle_post_receipt_root(ctx, hour, root, leaf_count)
    }

    /// View: does `leaf` belong to the root for `hour`?
    pub fn verify_receipt(ctx: Context<VerifyReceipt>, leaf: [u8; 32], proof: Vec<[u8; 32]>, index: u64) -> Result<bool> {
        instructions::receipts::handle_verify_receipt(ctx, leaf, proof, index)
    }
}
