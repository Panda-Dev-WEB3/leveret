//! LiteSVM harness shared by the integration tests.
//!
//! Programs are loaded from `target/deploy/*.so` (build with `anchor build`
//! or `scripts/wsl-build.sh` first). USDC is created at its real mainnet
//! address so the hard-coded collateral check is exercised as-is.

pub use anchor_lang::{prelude::Pubkey, AccountDeserialize, InstructionData, ToAccountMetas};
use litesvm::{types::TransactionMetadata, LiteSVM};
pub use lvrt_common::{seeds, sigverify::{PriceMsg, ED25519_PROGRAM_ID, PRICE_MSG_DOMAIN}, USDC_MINT};
use solana_account::Account;
use solana_clock::Clock;
pub use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_program_option::COption;
use solana_program_pack::Pack;
pub use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

pub use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};

pub mod fixture;
pub mod engine;
pub mod gov;
pub mod pool;

pub const BPF_UPGRADEABLE: Pubkey = lvrt_common::BPF_LOADER_UPGRADEABLE;
pub const SPL_TOKEN: Pubkey = anchor_lang::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022: Pubkey = anchor_lang::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const SYSTEM: Pubkey = anchor_lang::solana_program::system_program::ID;
pub const IX_SYSVAR: Pubkey = anchor_lang::pubkey!("Sysvar1nstructions1111111111111111111111111");
/// Thursday 2025-10-09 08:53:20 UTC — a weekday, so equities aren't calendar-closed.
pub const T0: i64 = 1_760_000_000;

pub struct Env {
    pub svm: LiteSVM,
    pub deployer: Keypair,
    pub authority: Keypair,
    pub guardian: Keypair,
    pub usdc_authority: Keypair,
}

pub type TxResult = Result<TransactionMetadata, (String, Vec<String>)>;

fn so(name: &str) -> Vec<u8> {
    let p = format!("{}/../target/deploy/{name}.so", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("{p}: {e} — run `anchor build` first"))
}

pub fn program_data_address(program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program.as_ref()], &BPF_UPGRADEABLE).0
}

impl Env {
    pub fn new() -> Self {
        let mut svm = LiteSVM::new();
        let deployer = Keypair::new();
        let authority = Keypair::new();
        let guardian = Keypair::new();
        let usdc_authority = Keypair::new();
        for k in [&deployer, &authority, &guardian, &usdc_authority] {
            svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
        }
        let mut env = Env { svm, deployer, authority, guardian, usdc_authority };
        for (id, name) in [
            (lvrt_gov::ID, "lvrt_gov"),
            (lvrt_oracle::ID, "lvrt_oracle"),
            (lvrt_engine::ID, "lvrt_engine"),
            (lvrt_tickets::ID, "lvrt_tickets"),
            (lvrt_vault::ID, "lvrt_vault"),
            (lvrt_insurance::ID, "lvrt_insurance"),
            (lvrt_fee_router::ID, "lvrt_fee_router"),
        ] {
            env.svm.add_program(id, &so(name)).unwrap();
            env.set_upgrade_authority(&id);
        }
        env.set_time(T0);
        env.create_usdc_mint();
        env
    }

    /// LiteSVM deploys with no upgrade authority; give it to `deployer` so
    /// the one-shot initializers' upgrade-authority guard is exercised.
    fn set_upgrade_authority(&mut self, program: &Pubkey) {
        let pd = program_data_address(program);
        let mut acc = self.svm.get_account(&pd).expect("programdata");
        acc.data[12] = 1;
        acc.data[13..45].copy_from_slice(self.deployer.pubkey().as_ref());
        self.svm.set_account(pd, acc).unwrap();
    }

    pub fn set_time(&mut self, unix: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = unix;
        c.slot += 1;
        self.svm.set_sysvar(&c);
        self.svm.expire_blockhash();
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn advance(&mut self, secs: i64) {
        let t = self.now() + secs;
        self.set_time(t);
    }

    /// A classic SPL mint at a fresh address (e.g. a stand-in $LVRT).
    pub fn create_mint(&mut self, decimals: u8) -> Pubkey {
        let addr = Keypair::new().pubkey();
        let mint = spl_token_interface::state::Mint {
            mint_authority: COption::Some(self.usdc_authority.pubkey()),
            supply: 0,
            decimals,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token_interface::state::Mint::LEN];
        mint.pack_into_slice(&mut data);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(addr, Account { lamports, data, owner: SPL_TOKEN, executable: false, rent_epoch: 0 }).unwrap();
        addr
    }

    /// An empty token account for `mint` under `token_program` (SPL or Token-2022).
    pub fn token_account(&mut self, mint: &Pubkey, owner: &Pubkey, token_program: &Pubkey) -> Pubkey {
        self.token_account_with(mint, owner, token_program, 0)
    }

    /// A token account for `mint` holding `amount`.
    pub fn token_account_with(&mut self, mint: &Pubkey, owner: &Pubkey, token_program: &Pubkey, amount: u64) -> Pubkey {
        let addr = Keypair::new().pubkey();
        let acc = spl_token_interface::state::Account {
            mint: *mint,
            owner: *owner,
            amount,
            delegate: COption::None,
            state: spl_token_interface::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token_interface::state::Account::LEN];
        acc.pack_into_slice(&mut data);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(addr, Account { lamports, data, owner: *token_program, executable: false, rent_epoch: 0 }).unwrap();
        addr
    }

    fn create_usdc_mint(&mut self) {
        let mint = spl_token_interface::state::Mint {
            mint_authority: COption::Some(self.usdc_authority.pubkey()),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token_interface::state::Mint::LEN];
        mint.pack_into_slice(&mut data);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(USDC_MINT, Account { lamports, data, owner: SPL_TOKEN, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    /// A USDC token account for `owner` holding `amount` (address is random).
    pub fn usdc_account(&mut self, owner: &Pubkey, amount: u64) -> Pubkey {
        let addr = Keypair::new().pubkey();
        self.put_usdc(&addr, owner, amount);
        addr
    }

    /// Write a USDC token account at `addr` (overwrites, e.g. to fund a PDA vault).
    pub fn put_usdc(&mut self, addr: &Pubkey, owner: &Pubkey, amount: u64) {
        let addr = *addr;
        let acc = spl_token_interface::state::Account {
            mint: USDC_MINT,
            owner: *owner,
            amount,
            delegate: COption::None,
            state: spl_token_interface::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0u8; spl_token_interface::state::Account::LEN];
        acc.pack_into_slice(&mut data);
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(addr, Account { lamports, data, owner: SPL_TOKEN, executable: false, rent_epoch: 0 }).unwrap();
    }

    pub fn token_balance(&self, addr: &Pubkey) -> u64 {
        let a = self.svm.get_account(addr).unwrap();
        spl_token_interface::state::Account::unpack(&a.data).unwrap().amount
    }

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        let payer = signers[0].pubkey();
        let bh = self.svm.latest_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&payer), &bh);
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
        let r = self.svm.send_transaction(tx).map_err(|e| (format!("{:?}", e.err), e.meta.logs));
        self.svm.expire_blockhash();
        r
    }

    pub fn ok(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TransactionMetadata {
        match self.send(ixs, signers) {
            Ok(m) => m,
            Err((e, logs)) => panic!("tx failed: {e}\n{}", logs.join("\n")),
        }
    }

    /// Assert failure and that the logs mention `needle` (an error name).
    pub fn fails_with(&mut self, ixs: &[Instruction], signers: &[&Keypair], needle: &str) {
        match self.send(ixs, signers) {
            Ok(_) => panic!("expected failure containing {needle}"),
            Err((e, logs)) => {
                let all = logs.join("\n");
                assert!(all.contains(needle) || e.contains(needle), "expected {needle}, got {e}\n{all}");
            }
        }
    }

    pub fn account<T: AccountDeserialize>(&self, addr: &Pubkey) -> T {
        let a = self.svm.get_account(addr).unwrap_or_else(|| panic!("missing account {addr}"));
        T::try_deserialize(&mut a.data.as_slice()).unwrap()
    }

    pub fn exists(&self, addr: &Pubkey) -> bool {
        self.svm.get_account(addr).map(|a| a.lamports > 0).unwrap_or(false)
    }

    pub fn funded(&mut self) -> Keypair {
        let k = Keypair::new();
        self.svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        k
    }
}

impl Default for Env {
    fn default() -> Self {
        Self::new()
    }
}

pub fn ix<D: InstructionData, A: ToAccountMetas>(program: Pubkey, data: D, accounts: A, remaining: Vec<AccountMeta>) -> Instruction {
    let mut metas = accounts.to_account_metas(None);
    metas.extend(remaining);
    Instruction { program_id: program, accounts: metas, data: data.data() }
}

pub fn pda(seeds: &[&[u8]], program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

// ------------------------------------------------------------- Ed25519 / oracle

/// Native Ed25519 verify instruction with all offsets pointing into itself.
pub fn ed25519_ix(signer: &Keypair, message: &[u8]) -> Instruction {
    const START: u16 = 16;
    let sig = signer.sign_message(message);
    let pk_off = START;
    let sig_off = pk_off + 32;
    let msg_off = sig_off + 64;
    let mut d = Vec::with_capacity(msg_off as usize + message.len());
    d.extend_from_slice(&[1u8, 0u8]);
    for v in [sig_off, u16::MAX, pk_off, u16::MAX, msg_off, message.len() as u16, u16::MAX] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(signer.pubkey().as_ref());
    d.extend_from_slice(sig.as_ref());
    d.extend_from_slice(message);
    Instruction { program_id: ED25519_PROGRAM_ID, accounts: vec![], data: d }
}

pub fn price_msg(market_id: u32, mid: i64, half_spread: i64, ts_ms: i64, session: u8, halted: bool) -> Vec<u8> {
    use anchor_lang::AnchorSerialize;
    let mut out = Vec::new();
    PriceMsg {
        domain: PRICE_MSG_DOMAIN,
        market_id,
        mid,
        bid: mid - half_spread,
        ask: mid + half_spread,
        band_bps: 0,
        ts_ms,
        session,
        halted,
        ca_flags: 0,
    }
    .serialize(&mut out)
    .unwrap();
    out
}

pub mod oracle {
    use super::*;
    use lvrt_oracle::{accounts as acc, instruction as ins, FeedParams, SignerKind, SignerParams};

    pub fn config() -> Pubkey {
        pda(&[seeds::CONFIG], &lvrt_oracle::ID)
    }
    pub fn calendar() -> Pubkey {
        pda(&[seeds::CALENDAR], &lvrt_oracle::ID)
    }
    pub fn feed(id: u32) -> Pubkey {
        pda(&[seeds::FEED, &id.to_le_bytes()], &lvrt_oracle::ID)
    }
    pub fn price(id: u32) -> Pubkey {
        pda(&[seeds::PRICE, &id.to_le_bytes()], &lvrt_oracle::ID)
    }
    pub fn signer_key(k: &Pubkey) -> Pubkey {
        pda(&[seeds::SIGNER, k.as_ref()], &lvrt_oracle::ID)
    }

    pub fn initialize(env: &mut Env) {
        let i = ix(
            lvrt_oracle::ID,
            ins::Initialize { authority: env.authority.pubkey(), guardian: env.guardian.pubkey() },
            acc::Initialize {
                payer: env.deployer.pubkey(),
                config: config(),
                calendar: calendar(),
                program: lvrt_oracle::ID,
                program_data: program_data_address(&lvrt_oracle::ID),
                system_program: SYSTEM,
            },
            vec![],
        );
        let d = env.deployer.insecure_clone();
        env.ok(&[i], &[&d]);
    }

    pub fn register(env: &mut Env, key: &Pubkey, source: u8, kind: SignerKind) {
        let valid_until = env.now() + 86_400;
        let i = ix(
            lvrt_oracle::ID,
            ins::RegisterSigner {
                params: SignerParams { pubkey: *key, kind, source, attestation_hash: [7; 32], tcb_level: 1, valid_until },
            },
            acc::RegisterSigner {
                payer: env.authority.pubkey(),
                authority: env.authority.pubkey(),
                config: config(),
                signer_key: signer_key(key),
                system_program: SYSTEM,
            },
            vec![],
        );
        let a = env.authority.insecure_clone();
        env.ok(&[i], &[&a]);
    }

    pub fn create_feed(env: &mut Env, p: FeedParams) {
        let i = ix(
            lvrt_oracle::ID,
            ins::CreateFeed { params: p },
            acc::CreateFeed {
                payer: env.authority.pubkey(),
                authority: env.authority.pubkey(),
                config: config(),
                feed: feed(p.market_id),
                price_state: price(p.market_id),
                system_program: SYSTEM,
            },
            vec![],
        );
        let a = env.authority.insecure_clone();
        env.ok(&[i], &[&a]);
    }

    /// `[ed25519 × n] [post_prices]` — returns the instructions so a caller
    /// can append an engine instruction to the same transaction.
    pub fn post_ixs(market_id: u32, signed: &[(&Keypair, Vec<u8>)]) -> Vec<Instruction> {
        let mut v: Vec<Instruction> = signed.iter().map(|(k, m)| ed25519_ix(k, m)).collect();
        v.push(ix(
            lvrt_oracle::ID,
            ins::PostPrices {},
            acc::PostPrices { feed: feed(market_id), price_state: price(market_id), calendar: calendar(), instructions: IX_SYSVAR },
            signed.iter().map(|(k, _)| AccountMeta::new_readonly(signer_key(&k.pubkey()), false)).collect(),
        ));
        v
    }
}
