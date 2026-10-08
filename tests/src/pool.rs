//! LLP vault bucket + insurance fund + fee router inbox for one bucket, wired
//! to the engine signer so `settle_shard` can move money between them.

use crate::*;
use lvrt_common::Bucket;

pub mod vault {
    use super::*;
    pub fn config() -> Pubkey {
        pda(&[seeds::CONFIG], &lvrt_vault::ID)
    }
    pub fn bucket(b: Bucket) -> Pubkey {
        pda(&[seeds::BUCKET, &[b.id()]], &lvrt_vault::ID)
    }
    pub fn lp_mint(b: Bucket) -> Pubkey {
        pda(&[seeds::LP_MINT, &[b.id()]], &lvrt_vault::ID)
    }
    pub fn lp_escrow(b: Bucket) -> Pubkey {
        pda(&[seeds::WITHDRAWAL, &[b.id()]], &lvrt_vault::ID)
    }
    pub fn usdc_vault(b: Bucket) -> Pubkey {
        pda(&[seeds::CUSTODY, &[b.id()]], &lvrt_vault::ID)
    }
}

pub mod insurance {
    use super::*;
    pub fn config() -> Pubkey {
        pda(&[seeds::CONFIG], &lvrt_insurance::ID)
    }
    pub fn fund(b: Bucket) -> Pubkey {
        pda(&[seeds::INSURANCE, &[b.id()]], &lvrt_insurance::ID)
    }
    pub fn usdc_vault(b: Bucket) -> Pubkey {
        pda(&[seeds::CUSTODY, &[b.id()]], &lvrt_insurance::ID)
    }
    pub fn stake_vault(b: Bucket) -> Pubkey {
        pda(&[seeds::STAKE, &[b.id()]], &lvrt_insurance::ID)
    }
}

pub mod router {
    use super::*;
    pub fn config() -> Pubkey {
        pda(&[seeds::CONFIG], &lvrt_fee_router::ID)
    }
    pub fn signer() -> Pubkey {
        pda(&[seeds::ROUTER], &lvrt_fee_router::ID)
    }
    pub fn burn_vault() -> Pubkey {
        pda(&[seeds::ROUTER, b"burn"], &lvrt_fee_router::ID)
    }
    pub fn inbox(b: Bucket) -> Pubkey {
        pda(&[seeds::FEE_INBOX, &[b.id()]], &lvrt_fee_router::ID)
    }
}

pub struct Pool {
    pub bucket: Bucket,
    pub treasury: Pubkey,
}

/// Initialise vault, insurance and fee router (once per Env) and create the
/// bucket's LLP state, insurance fund and fee inbox.
pub fn setup(env: &mut Env, bucket: Bucket, max_oi: u64) -> Pool {
    let d = env.deployer.insecure_clone();
    let a = env.authority.insecure_clone();
    let engine_signer = crate::engine::signer();

    env.ok(
        &[ix(
            lvrt_vault::ID,
            lvrt_vault::instruction::Initialize { authority: a.pubkey(), guardian: env.guardian.pubkey(), engine_signer },
            lvrt_vault::accounts::Initialize {
                payer: d.pubkey(),
                config: vault::config(),
                usdc_mint: USDC_MINT,
                program: lvrt_vault::ID,
                program_data: program_data_address(&lvrt_vault::ID),
                system_program: SYSTEM,
            },
            vec![],
        )],
        &[&d],
    );
    env.ok(
        &[ix(
            lvrt_vault::ID,
            lvrt_vault::instruction::CreateBucket { bucket, max_oi, utilization_cap_bps: 8_000 },
            lvrt_vault::accounts::CreateBucket {
                payer: a.pubkey(),
                authority: a.pubkey(),
                config: vault::config(),
                bucket_state: vault::bucket(bucket),
                lp_mint: vault::lp_mint(bucket),
                lp_escrow: vault::lp_escrow(bucket),
                usdc_mint: USDC_MINT,
                usdc_vault: vault::usdc_vault(bucket),
                lp_token_program: TOKEN_2022,
                usdc_token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        )],
        &[&a],
    );

    let lvrt_mint = env.create_mint(6);
    env.ok(
        &[ix(
            lvrt_insurance::ID,
            lvrt_insurance::instruction::Initialize { authority: a.pubkey(), guardian: env.guardian.pubkey(), engine_signer },
            lvrt_insurance::accounts::Initialize {
                payer: d.pubkey(),
                config: insurance::config(),
                usdc_mint: USDC_MINT,
                lvrt_mint,
                program: lvrt_insurance::ID,
                program_data: program_data_address(&lvrt_insurance::ID),
                system_program: SYSTEM,
            },
            vec![],
        )],
        &[&d],
    );
    env.ok(
        &[ix(
            lvrt_insurance::ID,
            lvrt_insurance::instruction::CreateFund { bucket, max_oi },
            lvrt_insurance::accounts::CreateFund {
                payer: a.pubkey(),
                authority: a.pubkey(),
                config: insurance::config(),
                fund: insurance::fund(bucket),
                usdc_mint: USDC_MINT,
                lvrt_mint,
                usdc_vault: insurance::usdc_vault(bucket),
                stake_vault: insurance::stake_vault(bucket),
                usdc_token_program: SPL_TOKEN,
                lvrt_token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        )],
        &[&a],
    );

    let treasury = env.usdc_account(&a.pubkey(), 0);
    env.ok(
        &[ix(
            lvrt_fee_router::ID,
            lvrt_fee_router::instruction::Initialize { authority: a.pubkey(), treasury },
            lvrt_fee_router::accounts::Initialize {
                payer: d.pubkey(),
                config: router::config(),
                router_signer: router::signer(),
                usdc_mint: USDC_MINT,
                burn_vault: router::burn_vault(),
                program: lvrt_fee_router::ID,
                program_data: program_data_address(&lvrt_fee_router::ID),
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        )],
        &[&d],
    );
    env.ok(
        &[ix(
            lvrt_fee_router::ID,
            lvrt_fee_router::instruction::InitInbox { bucket },
            lvrt_fee_router::accounts::InitInbox {
                payer: d.pubkey(),
                config: router::config(),
                router_signer: router::signer(),
                usdc_mint: USDC_MINT,
                inbox: router::inbox(bucket),
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        )],
        &[&d],
    );
    Pool { bucket, treasury }
}

/// An LP deposits `amount` USDC into the bucket (NAV must be fresh).
pub fn lp_deposit(env: &mut Env, pool: &Pool, lp: &Keypair, amount: u64) -> Pubkey {
    let usdc = env.usdc_account(&lp.pubkey(), amount);
    let lp_tokens = env.token_account(&vault::lp_mint(pool.bucket), &lp.pubkey(), &TOKEN_2022);
    env.ok(
        &[ix(
            lvrt_vault::ID,
            lvrt_vault::instruction::Deposit { amount, min_shares: 1 },
            lvrt_vault::accounts::Deposit {
                depositor: lp.pubkey(),
                bucket_state: vault::bucket(pool.bucket),
                lp_mint: vault::lp_mint(pool.bucket),
                lp_escrow: vault::lp_escrow(pool.bucket),
                depositor_lp: lp_tokens,
                usdc_mint: USDC_MINT,
                depositor_usdc: usdc,
                usdc_vault: vault::usdc_vault(pool.bucket),
                lp_token_program: TOKEN_2022,
                usdc_token_program: SPL_TOKEN,
            },
            vec![],
        )],
        &[lp],
    );
    lp_tokens
}

pub fn fund_insurance(env: &mut Env, pool: &Pool, amount: u64) {
    let payer = env.funded();
    let src = env.usdc_account(&payer.pubkey(), amount);
    env.ok(
        &[ix(
            lvrt_insurance::ID,
            lvrt_insurance::instruction::Contribute { amount },
            lvrt_insurance::accounts::Contribute {
                payer: payer.pubkey(),
                fund: insurance::fund(pool.bucket),
                usdc_mint: USDC_MINT,
                source: src,
                usdc_vault: insurance::usdc_vault(pool.bucket),
                token_program: SPL_TOKEN,
            },
            vec![],
        )],
        &[&payer],
    );
}

pub fn settle_ix(pool: &Pool, market_id: u32, shard_index: u8, custody_index: u8) -> Instruction {
    ix(
        lvrt_engine::ID,
        lvrt_engine::instruction::SettleShard { custody_index },
        lvrt_engine::accounts::SettleShard {
            config: crate::engine::config(),
            engine_signer: crate::engine::signer(),
            market: crate::engine::market(market_id),
            shard: crate::engine::shard(market_id, shard_index),
            usdc_mint: USDC_MINT,
            custody: crate::engine::custody(custody_index),
            fee_inbox: router::inbox(pool.bucket),
            vault_config: vault::config(),
            bucket_state: vault::bucket(pool.bucket),
            bucket_vault: vault::usdc_vault(pool.bucket),
            insurance_config: insurance::config(),
            fund: insurance::fund(pool.bucket),
            insurance_vault: insurance::usdc_vault(pool.bucket),
            vault_program: lvrt_vault::ID,
            insurance_program: lvrt_insurance::ID,
            token_program: SPL_TOKEN,
        },
        vec![],
    )
}

pub fn distribute_ix(pool: &Pool) -> Instruction {
    ix(
        lvrt_fee_router::ID,
        lvrt_fee_router::instruction::Distribute {},
        lvrt_fee_router::accounts::Distribute {
            config: router::config(),
            router_signer: router::signer(),
            usdc_mint: USDC_MINT,
            inbox: router::inbox(pool.bucket),
            bucket_state: vault::bucket(pool.bucket),
            fund: insurance::fund(pool.bucket),
            bucket_vault: vault::usdc_vault(pool.bucket),
            insurance_vault: insurance::usdc_vault(pool.bucket),
            treasury: pool.treasury,
            burn_vault: router::burn_vault(),
            token_program: SPL_TOKEN,
        },
        vec![],
    )
}

/// Σ USDC across all engine custody shards.
pub fn custody_total(env: &Env) -> u64 {
    (0..crate::engine::CUSTODY_COUNT).map(|k| env.token_balance(&crate::engine::custody(k))).sum()
}
