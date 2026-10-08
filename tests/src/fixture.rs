//! Fixture: oracle with two registered pushers, engine, and a Core SOL market.

use crate::*;
use lvrt_common::{lvrt_math::oracle::source, Bucket, Family, Side};
use lvrt_engine::{MarginAccount, OpenArgs};
use lvrt_oracle::{FeedParams, SignerKind};

pub const SOL: u32 = 1;
pub const USD: i64 = 100_000_000; // price scale
pub const USDC: u64 = 1_000_000;
pub const UNIT: u64 = 1_000_000; // base scale

pub struct Core {
    pub env: Env,
    pub pusher_a: Keypair,
    pub pusher_b: Keypair,
}

impl Core {
    pub fn new() -> Self {
        Self::with_engine_authority(None)
    }

    pub fn with_engine_authority(authority: Option<Pubkey>) -> Self {
        let mut env = Env::new();
        oracle::initialize(&mut env);
        let pusher_a = Keypair::new();
        let pusher_b = Keypair::new();
        oracle::register(&mut env, &pusher_a.pubkey(), source::CHAINLINK, SignerKind::Pusher);
        oracle::register(&mut env, &pusher_b.pubkey(), source::SWITCHBOARD, SignerKind::Pusher);
        oracle::create_feed(
            &mut env,
            FeedParams {
                market_id: SOL,
                family: Family::Core,
                symbol: *b"SOL\0\0\0\0\0\0\0\0\0\0\0\0\0",
                allowed_sources: 0b11,
                min_sources: 2,
                max_dev_bps: 50,
                fresh_ms: 800,
                band_limit_bps: 200,
                normal_band_bps: 10,
                chainlink_feed_id: [0; 32],
                switchboard_feed_id: [0; 32],
                min_source_depth_usd: 1_000_000,
                measured_source_depth_usd: 50_000_000,
            },
        );
        let auth = authority.unwrap_or(env.authority.pubkey());
        engine::initialize(&mut env, auth);
        let mut c = Core { env, pusher_a, pusher_b };
        if authority.is_none() {
            engine::create_market(&mut c.env, SOL, Family::Core, Bucket::Core, 800, engine::core_risk());
        }
        c
    }

    /// Both sources sign `mid` at the current time.
    pub fn quote(&self, mid: i64) -> Vec<Instruction> {
        self.quote_with(mid, true)
    }

    pub fn quote_with(&self, mid: i64, both: bool) -> Vec<Instruction> {
        let ts = self.env.now() * 1_000 + 500;
        let a = price_msg(SOL, mid, USD / 100, ts, 0, false);
        if both {
            let b = price_msg(SOL, mid, USD / 100, ts, 0, false);
            oracle::post_ixs(SOL, &[(&self.pusher_a, a), (&self.pusher_b, b)])
        } else {
            oracle::post_ixs(SOL, &[(&self.pusher_a, a)])
        }
    }

    pub fn post(&mut self, mid: i64) {
        let ixs = self.quote(mid);
        let p = self.env.deployer.insecure_clone();
        self.env.ok(&ixs, &[&p]);
    }

    pub fn post_fails_expired(&mut self) {
        let ixs = self.quote(150 * USD);
        let p = self.env.deployer.insecure_clone();
        self.env.fails_with(&ixs, &[&p], "UnknownSigner");
    }

    pub fn margin(&self, m: &Pubkey) -> MarginAccount {
        self.env.account(m)
    }
}

pub fn long(size_units: u64, lev_x: u32, bound: i64) -> OpenArgs {
    OpenArgs { side: Side::Long, size: size_units * UNIT, price_bound: bound, leverage_x100: lev_x * 100, isolated_margin: 0 }
}

