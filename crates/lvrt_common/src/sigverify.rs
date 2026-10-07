//! Ed25519 signature checks by instruction introspection.
//!
//! The transaction carries one or more native Ed25519 program instructions
//! (the runtime verifies the signatures); programs read them back through the
//! instructions sysvar and accept only messages whose bytes live inside the
//! Ed25519 instruction itself (all `*_instruction_index` fields == u16::MAX),
//! which rules out offset tricks pointing at attacker-controlled data.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::CommonError;

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

const HEADER: usize = 2;
const OFFSETS_LEN: usize = 14;
const THIS_IX: u16 = u16::MAX;

/// A verified (signer, message) pair.
pub struct SignedMessage {
    pub signer: Pubkey,
    pub message: Vec<u8>,
}

fn rd16(d: &[u8], at: usize) -> Result<u16> {
    let b = d.get(at..at + 2).ok_or(CommonError::BadSignatureIx)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

/// Parse every signature in one Ed25519 instruction's data.
pub fn parse_ed25519_ix(data: &[u8], out: &mut Vec<SignedMessage>) -> Result<()> {
    let n = *data.first().ok_or(CommonError::BadSignatureIx)? as usize;
    for i in 0..n {
        let o = HEADER + i * OFFSETS_LEN;
        let sig_ix = rd16(data, o + 2)?;
        let pk_off = rd16(data, o + 4)? as usize;
        let pk_ix = rd16(data, o + 6)?;
        let msg_off = rd16(data, o + 8)? as usize;
        let msg_len = rd16(data, o + 10)? as usize;
        let msg_ix = rd16(data, o + 12)?;
        require!(sig_ix == THIS_IX && pk_ix == THIS_IX && msg_ix == THIS_IX, CommonError::BadSignatureIx);
        let pk = data.get(pk_off..pk_off + 32).ok_or(CommonError::BadSignatureIx)?;
        let msg = data.get(msg_off..msg_off + msg_len).ok_or(CommonError::BadSignatureIx)?;
        out.push(SignedMessage {
            signer: Pubkey::try_from(pk).map_err(|_| CommonError::BadSignatureIx)?,
            message: msg.to_vec(),
        });
    }
    Ok(())
}

/// Collect all Ed25519-verified messages that precede the current instruction.
pub fn verified_messages(ix_sysvar: &AccountInfo) -> Result<Vec<SignedMessage>> {
    let current = load_current_index_checked(ix_sysvar)? as usize;
    let mut out = Vec::new();
    for i in 0..current {
        let ix = load_instruction_at_checked(i, ix_sysvar)?;
        if ix.program_id == ED25519_PROGRAM_ID {
            parse_ed25519_ix(&ix.data, &mut out)?;
        }
    }
    Ok(out)
}

/// Canonical signed price message (enclave, trusted pushers, and the decoded
/// form of Chainlink / Switchboard reports once their verifier CPI passes).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct PriceMsg {
    /// Domain separator: `b"LVRTPX01"`.
    pub domain: [u8; 8],
    pub market_id: u32,
    pub mid: i64,
    pub bid: i64,
    pub ask: i64,
    pub band_bps: u16,
    pub ts_ms: i64,
    /// `Session` as u8 (from the stream's market-status flag).
    pub session: u8,
    pub halted: bool,
    pub ca_flags: u8,
}

pub const PRICE_MSG_DOMAIN: [u8; 8] = *b"LVRTPX01";

impl PriceMsg {
    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let m = PriceMsg::try_from_slice(bytes).map_err(|_| CommonError::BadSignatureIx)?;
        require!(m.domain == PRICE_MSG_DOMAIN, CommonError::BadSignatureIx);
        Ok(m)
    }
}
