use anchor_lang::prelude::*;
use lvrt_common::{hashv, seeds};

use crate::{
    error::OracleError,
    state::{ReceiptRoot, SignerKey, SignerKind},
};

#[derive(Accounts)]
#[instruction(hour: u64)]
pub struct PostReceiptRoot<'info> {
    #[account(mut)]
    pub poster: Signer<'info>,
    #[account(
        seeds = [seeds::SIGNER, poster.key().as_ref()],
        bump = signer_key.bump,
        constraint = signer_key.kind == SignerKind::Receipts && signer_key.active @ OracleError::UnknownSigner
    )]
    pub signer_key: Account<'info, SignerKey>,
    #[account(init, payer = poster, space = 8 + ReceiptRoot::INIT_SPACE, seeds = [seeds::RECEIPT, &hour.to_le_bytes()], bump)]
    pub receipt: Account<'info, ReceiptRoot>,
    pub system_program: Program<'info, System>,
}

/// Roots are write-once: a published hour can never be rewritten.
pub fn handle_post_receipt_root(ctx: Context<PostReceiptRoot>, hour: u64, root: [u8; 32], leaf_count: u64) -> Result<()> {
    let now_hour = (Clock::get()?.unix_timestamp / 3_600) as u64;
    require!(hour < now_hour, OracleError::BadMessage); // only closed hours
    let r = &mut ctx.accounts.receipt;
    r.hour = hour;
    r.root = root;
    r.leaf_count = leaf_count;
    r.posted_by = ctx.accounts.poster.key();
    r.bump = ctx.bumps.receipt;
    Ok(())
}

#[derive(Accounts)]
pub struct VerifyReceipt<'info> {
    #[account(seeds = [seeds::RECEIPT, &receipt.hour.to_le_bytes()], bump = receipt.bump)]
    pub receipt: Account<'info, ReceiptRoot>,
}

/// Standard binary Merkle proof with sha256 and positional ordering.
pub fn merkle_root(leaf: [u8; 32], proof: &[[u8; 32]], mut index: u64) -> [u8; 32] {
    let mut h = leaf;
    for sib in proof {
        h = if index & 1 == 0 { hashv(&[&h, sib]).to_bytes() } else { hashv(&[sib, &h]).to_bytes() };
        index >>= 1;
    }
    h
}

pub fn handle_verify_receipt(ctx: Context<VerifyReceipt>, leaf: [u8; 32], proof: Vec<[u8; 32]>, index: u64) -> Result<bool> {
    let r = &ctx.accounts.receipt;
    require!(index < r.leaf_count, OracleError::BadProof);
    Ok(merkle_root(leaf, &proof, index) == r.root)
}
