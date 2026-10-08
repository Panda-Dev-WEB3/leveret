use anchor_lang::prelude::*;

#[error_code]
pub enum EngineError {
    #[msg("Signer is not the timelock authority")]
    NotAuthority,
    #[msg("Signer is neither authority nor guardian")]
    NotAuthorityOrGuardian,
    #[msg("The guardian can only tighten")]
    GuardianCannotLoosen,
    #[msg("Only USDC is accepted as collateral")]
    NotUsdc,
    #[msg("New positions are paused")]
    OpensPaused,
    #[msg("Market is reduce-only")]
    ReduceOnly,
    #[msg("Price is not LIVE")]
    PriceNotLive,
    #[msg("Market is frozen (halted or corporate action pending)")]
    MarketFrozen,
    #[msg("Price is stale")]
    StalePrice,
    #[msg("Band above market limit")]
    BandTooWide,
    #[msg("Opens not allowed in this session")]
    SessionClosed,
    #[msg("Fill outside the user's price bound")]
    Slippage,
    #[msg("Leverage above the allowed maximum")]
    LeverageTooHigh,
    #[msg("Open interest cap reached")]
    OiCap,
    #[msg("Position size above the per-account limit")]
    PositionLimit,
    #[msg("Insufficient margin")]
    InsufficientMargin,
    #[msg("Account is not liquidatable")]
    NotLiquidatable,
    #[msg("Wrong shard for this margin account")]
    WrongShard,
    #[msg("Wrong price account for this market")]
    WrongPriceState,
    #[msg("Remaining accounts must cover every open position")]
    HealthAccounts,
    #[msg("Signer is not the owner or an authorized delegate")]
    NotAuthorized,
    #[msg("Delegate budget exceeded")]
    DelegateBudget,
    #[msg("Position must be rescaled for a corporate action first")]
    CorporateActionPending,
    #[msg("Nothing to do")]
    Noop,
    #[msg("Trigger condition not met or expired")]
    TriggerNotMet,
    #[msg("Queued profit not yet releasable")]
    QueueLocked,
    #[msg("Too many open positions")]
    TooManyPositions,
    #[msg("Invalid parameters")]
    InvalidParams,
    #[msg("Custody shard can't cover this settlement; use another custody index")]
    InsufficientCustody,
    #[msg("Signer is not the ADL operator")]
    NotAdlOperator,
    #[msg("ADL needs (Market, FundingState, PriceState) for every market of the bucket")]
    AdlAccounts,
    #[msg("A market's merge is too old for ADL")]
    StaleMerge,
    #[msg("Bucket PnL ratio is below the ADL trigger")]
    AdlNotTriggered,
    #[msg("ADL can only close a profitable position")]
    AdlNotProfitable,
    #[msg("ADL ranks within a round must not increase")]
    AdlRankOrder,
    #[msg("Not implemented in the skeleton yet")]
    NotImplemented,
}
