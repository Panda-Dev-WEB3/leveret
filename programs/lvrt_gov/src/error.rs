use anchor_lang::prelude::*;

#[error_code]
pub enum GovError {
    #[msg("Only the admin multisig may queue proposals")]
    NotAdmin,
    #[msg("Only the admin or guardian may cancel")]
    NotAdminOrGuardian,
    #[msg("Only the timelock executor may call this")]
    NotExecutor,
    #[msg("Delay is below the 72h minimum")]
    DelayTooShort,
    #[msg("Proposal is not yet executable")]
    TooEarly,
    #[msg("Proposal grace period has expired")]
    Expired,
    #[msg("Proposal was already executed or cancelled")]
    NotPending,
    #[msg("Remaining accounts do not match the proposal")]
    AccountMismatch,
    #[msg("Proposal payload too large")]
    PayloadTooLarge,
    #[msg("Initializer must be the program upgrade authority")]
    NotUpgradeAuthority,
}
