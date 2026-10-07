use crate::*;
use lvrt_common::{Bucket, Family, Side};
use lvrt_engine::{accounts as acc, instruction as ins, FundingConfig, MarketParams, OpenArgs, RiskParams};

pub fn config() -> Pubkey {
    pda(&[seeds::CONFIG], &lvrt_engine::ID)
}
pub fn signer() -> Pubkey {
    pda(&[seeds::AUTHORITY], &lvrt_engine::ID)
}
pub fn custody(k: u8) -> Pubkey {
    pda(&[seeds::CUSTODY, &[k]], &lvrt_engine::ID)
}
pub fn market(id: u32) -> Pubkey {
    pda(&[seeds::MARKET, &id.to_le_bytes()], &lvrt_engine::ID)
}
pub fn funding(id: u32) -> Pubkey {
    pda(&[seeds::FUNDING, &id.to_le_bytes()], &lvrt_engine::ID)
}
pub fn shard(id: u32, k: u8) -> Pubkey {
    pda(&[seeds::SHARD, &id.to_le_bytes(), &[k]], &lvrt_engine::ID)
}
pub fn margin(owner: &Pubkey, sub: u8) -> Pubkey {
    pda(&[seeds::MARGIN, owner.as_ref(), &[sub]], &lvrt_engine::ID)
}
pub fn position(margin: &Pubkey, id: u32, side: Side) -> Pubkey {
    pda(&[seeds::POSITION, margin.as_ref(), &id.to_le_bytes(), &[side.seed()]], &lvrt_engine::ID)
}
pub fn shard_of(margin: &Pubkey, shards: u8) -> u8 {
    lvrt_math::shard::shard_for(&margin.to_bytes(), shards)
}

pub const CUSTODY_COUNT: u8 = 2;
pub const SHARDS: u8 = 8;

pub fn initialize(env: &mut Env, authority: Pubkey) {
    let i = ix(
        lvrt_engine::ID,
        ins::Initialize { authority, guardian: env.guardian.pubkey(), ca_operator: env.authority.pubkey(), custody_count: CUSTODY_COUNT },
        acc::Initialize {
            payer: env.deployer.pubkey(),
            config: config(),
            engine_signer: signer(),
            usdc_mint: USDC_MINT,
            program: lvrt_engine::ID,
            program_data: program_data_address(&lvrt_engine::ID),
            system_program: SYSTEM,
        },
        vec![],
    );
    let d = env.deployer.insecure_clone();
    env.ok(&[i], &[&d]);
    for k in 0..CUSTODY_COUNT {
        let i = ix(
            lvrt_engine::ID,
            ins::InitCustody { k },
            acc::InitCustody {
                payer: env.deployer.pubkey(),
                config: config(),
                engine_signer: signer(),
                usdc_mint: USDC_MINT,
                custody: custody(k),
                token_program: SPL_TOKEN,
                system_program: SYSTEM,
            },
            vec![],
        );
        env.ok(&[i], &[&d]);
    }
}

pub fn core_risk() -> RiskParams {
    RiskParams {
        max_lev_x100: 5_000,
        off_hours_lev_x100: 5_000,
        mm_bps: 100,
        mm_off_hours_bps: 100,
        oi_cap_long: 1_000_000 * 1_000_000,
        oi_cap_short: 1_000_000 * 1_000_000,
        max_position_notional: 1_000_000 * 1_000_000,
        base_spread_bps: 5,
        off_hours_spread_bps: 5,
        wide_spread_bps: 50,
        k_band_bps: 5_000,
        max_premium_bps: 100,
        skew_scale: 100_000 * 1_000_000,
        band_ref_bps: 50,
        band_limit_bps: 200,
        fee_tenth_bps: 60,
        liq_bounty_cap: 1_000 * 1_000_000,
    }
}

pub fn create_market(env: &mut Env, id: u32, family: Family, bucket: Bucket, fresh_ms: i64, risk: RiskParams) {
    let p = MarketParams {
        market_id: id,
        family,
        bucket,
        fresh_ms,
        risk,
        funding: FundingConfig {
            max_velocity: 10_000_000_000,
            max_rate: 100_000_000_000,
            imbalance_k: 0,
            borrow_base_ppm: 10,
            borrow_slope_ppm: 100,
        },
        shards: SHARDS,
        guarded: false,
    };
    let i = ix(
        lvrt_engine::ID,
        ins::CreateMarket { params: p },
        acc::CreateMarket {
            payer: env.authority.pubkey(),
            authority: env.authority.pubkey(),
            config: config(),
            market: market(id),
            funding_state: funding(id),
            price_state: crate::oracle::price(id),
            system_program: SYSTEM,
        },
        vec![],
    );
    let a = env.authority.insecure_clone();
    env.ok(&[i], &[&a]);
    for k in 0..SHARDS {
        let i = ix(
            lvrt_engine::ID,
            ins::InitShard { k },
            acc::InitShard { payer: env.authority.pubkey(), market: market(id), shard: shard(id, k), system_program: SYSTEM },
            vec![],
        );
        env.ok(&[i], &[&a]);
    }
}

/// Creates a margin account funded with `deposit` USDC; returns (margin, usdc account).
pub fn trader(env: &mut Env, owner: &Keypair, deposit: u64) -> (Pubkey, Pubkey) {
    let m = margin(&owner.pubkey(), 0);
    let i = ix(
        lvrt_engine::ID,
        ins::CreateMarginAccount { sub_id: 0 },
        acc::CreateMarginAccount { owner: owner.pubkey(), margin: m, system_program: SYSTEM },
        vec![],
    );
    env.ok(&[i], &[owner]);
    let usdc = env.usdc_account(&owner.pubkey(), 1_000_000 * 1_000_000);
    if deposit > 0 {
        let i = ix(
            lvrt_engine::ID,
            ins::Deposit { amount: deposit },
            acc::Deposit {
                owner: owner.pubkey(),
                margin: m,
                config: config(),
                usdc_mint: USDC_MINT,
                owner_usdc: usdc,
                custody: custody(shard_of(&m, CUSTODY_COUNT)),
                token_program: SPL_TOKEN,
            },
            vec![],
        );
        env.ok(&[i], &[owner]);
    }
    (m, usdc)
}

pub fn open_ix(signer: &Pubkey, m: &Pubkey, id: u32, args: OpenArgs) -> Instruction {
    ix(
        lvrt_engine::ID,
        ins::OpenPosition { args },
        acc::OpenPosition {
            signer: *signer,
            config: config(),
            margin: *m,
            market: market(id),
            funding_state: funding(id),
            price_state: crate::oracle::price(id),
            shard: shard(id, shard_of(m, SHARDS)),
            position: position(m, id, args.side),
            system_program: SYSTEM,
        },
        vec![],
    )
}

pub fn close_ix(signer: &Pubkey, owner: &Pubkey, m: &Pubkey, id: u32, side: Side, size: u64, bound: i64) -> Instruction {
    ix(
        lvrt_engine::ID,
        ins::ClosePosition { size, price_bound: bound },
        acc::ClosePosition {
            signer: *signer,
            margin: *m,
            market: market(id),
            funding_state: funding(id),
            price_state: crate::oracle::price(id),
            shard: shard(id, shard_of(m, SHARDS)),
            position: position(m, id, side),
            owner: *owner,
        },
        vec![],
    )
}

pub fn liquidate_ix(liquidator: &Pubkey, liq_margin: &Pubkey, owner: &Pubkey, m: &Pubkey, id: u32, side: Side, health: Vec<AccountMeta>) -> Instruction {
    ix(
        lvrt_engine::ID,
        ins::Liquidate {},
        acc::Liquidate {
            liquidator: *liquidator,
            liquidator_margin: *liq_margin,
            margin: *m,
            market: market(id),
            funding_state: funding(id),
            price_state: crate::oracle::price(id),
            shard: shard(id, shard_of(m, SHARDS)),
            position: position(m, id, side),
            owner: *owner,
        },
        health,
    )
}

pub fn withdraw_ix(signer: &Pubkey, m: &Pubkey, owner_usdc: &Pubkey, amount: u64, health: Vec<AccountMeta>) -> Instruction {
    ix(
        lvrt_engine::ID,
        ins::Withdraw { amount, custody_index: shard_of(m, CUSTODY_COUNT) },
        acc::Withdraw {
            signer: *signer,
            margin: *m,
            config: config(),
            engine_signer: crate::engine::signer(),
            usdc_mint: USDC_MINT,
            owner_usdc: *owner_usdc,
            custody: custody(shard_of(m, CUSTODY_COUNT)),
            token_program: SPL_TOKEN,
        },
        health,
    )
}

pub fn merge_ix(id: u32) -> Instruction {
    ix(
        lvrt_engine::ID,
        ins::MergeShards {},
        acc::MergeShards { market: market(id), funding_state: funding(id), price_state: crate::oracle::price(id) },
        (0..SHARDS).map(|k| AccountMeta::new(shard(id, k), false)).collect(),
    )
}

/// (Position, Market, FundingState, PriceState) per open position.
pub fn health_metas(m: &Pubkey, positions: &[(u32, Side)]) -> Vec<AccountMeta> {
    positions
        .iter()
        .flat_map(|(id, side)| {
            vec![
                AccountMeta::new_readonly(position(m, *id, *side), false),
                AccountMeta::new_readonly(market(*id), false),
                AccountMeta::new_readonly(funding(*id), false),
                AccountMeta::new_readonly(crate::oracle::price(*id), false),
            ]
        })
        .collect()
}

pub fn set_paused_ix(signer: &Pubkey, paused: bool) -> Instruction {
    ix(lvrt_engine::ID, ins::SetOpensPaused { paused }, acc::SetConfig { signer: *signer, config: config() }, vec![])
}
