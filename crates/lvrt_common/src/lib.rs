//! Types shared by every Leveret program. Kept free of program IDs so any
//! program can depend on it without cycles.

use anchor_lang::prelude::*;

pub use lvrt_math;
pub use solana_instructions_sysvar as ix_sysvar;
pub use solana_sha256_hasher::{hash, hashv};

pub mod sigverify;

/// USDC is the only collateral asset (design rule 5). Changing this is a
/// program upgrade, which itself sits behind the 72h timelock.
pub const USDC_MINT: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
/// USDT is accepted only as a deposit input and swapped to USDC.
pub const USDT_MINT: Pubkey = pubkey!("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB");
pub const USDC_DECIMALS: u8 = 6;

pub mod seeds {
    pub const CONFIG: &[u8] = b"config";
    /// lvrt_gov PDA that signs every timelocked action.
    pub const EXECUTOR: &[u8] = b"executor";
    pub const PROPOSAL: &[u8] = b"proposal";
    pub const PRICE: &[u8] = b"price";
    pub const FEED: &[u8] = b"feed";
    pub const SIGNER: &[u8] = b"signer";
    pub const ENCLAVE: &[u8] = b"enclave";
    pub const CALENDAR: &[u8] = b"calendar";
    pub const MARGIN: &[u8] = b"margin";
    pub const POSITION: &[u8] = b"pos";
    pub const MARKET: &[u8] = b"mkt";
    pub const SHARD: &[u8] = b"shard";
    pub const FUNDING: &[u8] = b"fund";
    pub const TRIGGER: &[u8] = b"trig";
    pub const CUSTODY: &[u8] = b"custody";
    pub const AUTHORITY: &[u8] = b"authority";
    pub const QUEUE: &[u8] = b"queue";
    pub const BUCKET: &[u8] = b"bucket";
    pub const LP_MINT: &[u8] = b"lp_mint";
    pub const WITHDRAWAL: &[u8] = b"withdrawal";
    pub const INSURANCE: &[u8] = b"insurance";
    pub const STAKE: &[u8] = b"stake";
    pub const POWER: &[u8] = b"power";
    pub const POWER_MINT: &[u8] = b"power_mint";
    pub const SHORT_VAULT: &[u8] = b"short";
    pub const CRAB: &[u8] = b"crab";
    pub const FACTOR: &[u8] = b"factor";
    pub const METHODOLOGY: &[u8] = b"method";
    pub const TICKET: &[u8] = b"ticket";
    pub const TWIN: &[u8] = b"twin";
    pub const TWIN_MINT: &[u8] = b"twin_mint";
    pub const RECEIPT: &[u8] = b"receipt";
    pub const ROUTER: &[u8] = b"router";
}

/// 72h timelock for every loosening action.
pub const TIMELOCK_DELAY_S: i64 = 72 * 3_600;
/// 30-day notice for factor methodology changes.
pub const METHODOLOGY_NOTICE_S: i64 = 30 * 86_400;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Family {
    Core,
    Stocks,
    SmallCap,
    Squared,
    Factors,
    Tickets,
    Twins,
}

impl Family {
    pub fn math(self) -> lvrt_math::risk::Family {
        use lvrt_math::risk::Family as F;
        match self {
            Family::Core => F::Core,
            Family::Stocks => F::Stocks,
            Family::SmallCap => F::SmallCap,
            Family::Squared => F::Squared,
            Family::Factors => F::Factors,
            Family::Tickets => F::Tickets,
            Family::Twins => F::Twins,
        }
    }
}

/// LLP buckets; each is isolated (own USDC accounting, insurance, tranche).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Bucket {
    Core,
    Stocks,
    SmallCap,
    Squared,
    Factors,
    Tickets,
}

impl Bucket {
    pub fn id(self) -> u8 {
        self as u8
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Session {
    Regular,
    Pre,
    Post,
    Overnight,
    Closed,
}

impl Session {
    pub fn is_off_hours(self) -> bool {
        self != Session::Regular
    }
    pub fn math(self) -> lvrt_math::risk::Session {
        use lvrt_math::risk::Session as S;
        match self {
            Session::Regular => S::Regular,
            Session::Pre => S::Pre,
            Session::Post => S::Post,
            Session::Overnight => S::Overnight,
            Session::Closed => S::Closed,
        }
    }
}

/// Market price state (§2.2, §6.1).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PriceStatus {
    /// Fresh, agreeing sources: opens and closes.
    Live,
    /// Sources disagree or band above limit: opens paused, closes allowed.
    Wide,
    /// Underlying halted: no opens; closes only per deleveraging rules.
    Halted,
    /// Corporate action pending: frozen until rescale + first fresh print.
    CaPending,
    /// Reduce-only, then settlement at last verified price.
    Delisted,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Side {
    Long,
    Short,
}

impl Side {
    pub fn math(self) -> lvrt_math::Side {
        match self {
            Side::Long => lvrt_math::Side::Long,
            Side::Short => lvrt_math::Side::Short,
        }
    }
    pub fn seed(self) -> u8 {
        self as u8
    }
}

/// Map `lvrt_math` errors into an Anchor error at the call site.
#[error_code(offset = 9000)]
pub enum CommonError {
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Division by zero")]
    MathDivideByZero,
    #[msg("Invalid math input")]
    MathInvalidInput,
    #[msg("Signer is neither the timelock executor nor the guardian")]
    Unauthorized,
    #[msg("The guardian can only tighten parameters")]
    GuardianCannotLoosen,
    #[msg("Malformed or unsafe Ed25519 signature instruction")]
    BadSignatureIx,
}

pub fn math_err(e: lvrt_math::MathError) -> anchor_lang::error::Error {
    match e {
        lvrt_math::MathError::Overflow => CommonError::MathOverflow.into(),
        lvrt_math::MathError::DivideByZero => CommonError::MathDivideByZero.into(),
        lvrt_math::MathError::InvalidInput => CommonError::MathInvalidInput.into(),
    }
}

/// `?`-friendly conversion: `lvrt_math::...(..).map_err(math_err)?`.
pub trait MathResultExt<T> {
    fn m(self) -> Result<T>;
}

impl<T> MathResultExt<T> for lvrt_math::MathResult<T> {
    fn m(self) -> Result<T> {
        self.map_err(math_err)
    }
}

pub const BPF_LOADER_UPGRADEABLE: Pubkey = pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");

/// One-shot initializers must be signed by the program's upgrade authority so
/// nobody can front-run `initialize` after deploy. Programs owned by a
/// non-upgradeable loader (only possible in local test harnesses) pass.
pub fn assert_upgrade_authority(program: &AccountInfo, program_data: &AccountInfo, signer: &Pubkey) -> Result<()> {
    if *program.owner != BPF_LOADER_UPGRADEABLE {
        return Ok(());
    }
    // UpgradeableLoaderState::Program { programdata_address } = tag 2 (u32) + pubkey
    let pd = {
        let d = program.try_borrow_data()?;
        require!(d.len() >= 36 && d[0..4] == 2u32.to_le_bytes(), CommonError::Unauthorized);
        Pubkey::try_from(&d[4..36]).map_err(|_| CommonError::Unauthorized)?
    };
    require_keys_eq!(pd, program_data.key(), CommonError::Unauthorized);
    // UpgradeableLoaderState::ProgramData { slot, upgrade_authority_address } =
    // tag 3 (u32) + slot (u64) + Option<Pubkey> (1 + 32)
    let d = program_data.try_borrow_data()?;
    require!(d.len() >= 45 && d[0..4] == 3u32.to_le_bytes() && d[12] == 1, CommonError::Unauthorized);
    let auth = Pubkey::try_from(&d[13..45]).map_err(|_| CommonError::Unauthorized)?;
    require_keys_eq!(auth, *signer, CommonError::Unauthorized);
    Ok(())
}

/// Address of the lvrt_gov executor PDA for a given gov program id.
pub fn executor_address(gov_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[seeds::EXECUTOR], gov_program).0
}

/// Tighten/loosen guard used by every program's parameter setters: the
/// guardian may only move a value in the safe direction; the timelock
/// executor may move it either way.
pub fn require_tighten_or_timelock<T: PartialOrd>(
    signer: &Pubkey,
    timelock: &Pubkey,
    guardian: &Pubkey,
    old: T,
    new: T,
    lower_is_tighter: bool,
) -> Result<()> {
    if signer == timelock {
        return Ok(());
    }
    require_keys_eq!(*signer, *guardian, CommonError::Unauthorized);
    let tighter = if lower_is_tighter { new <= old } else { new >= old };
    require!(tighter, CommonError::GuardianCannotLoosen);
    Ok(())
}
