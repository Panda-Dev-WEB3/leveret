use anchor_lang::prelude::*;

#[error_code]
pub enum OracleError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Signer is neither authority nor guardian")]
    NotAuthorityOrGuardian,
    #[msg("Guardian may only make the market more restrictive")]
    GuardianCannotLoosen,
    #[msg("Signer key is not registered, inactive or expired")]
    UnknownSigner,
    #[msg("Source not allowed for this feed")]
    SourceNotAllowed,
    #[msg("Message is for a different market")]
    WrongMarket,
    #[msg("No fresh price")]
    Stale,
    #[msg("Message older than the stored price")]
    OutOfOrder,
    #[msg("Malformed price message")]
    BadMessage,
    #[msg("Upstream verifier CPI not wired for this source yet")]
    VerifierNotWired,
    #[msg("Depth gate not met")]
    DepthGate,
    #[msg("Invalid feed parameters")]
    InvalidParams,
    #[msg("Holiday list must be sorted and fit the account")]
    BadCalendar,
    #[msg("Receipt proof does not verify")]
    BadProof,
}
