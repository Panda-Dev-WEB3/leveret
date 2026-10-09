// Idempotent test-cluster bootstrap: mints, oracle (signers + feeds), engine
// (custody, markets, shards, ADL), vault buckets, insurance funds, fee router
// inboxes, and seed LP liquidity. Safe to re-run; existing state is skipped.
//
//   LVRT_CLUSTER=localnet node web/dev/bootstrap.ts
//   LVRT_CLUSTER=devnet   node web/dev/bootstrap.ts
import { resolve } from "node:path";
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token";
import * as eng from "../src/generated/lvrt_engine/index.ts";
import * as orc from "../src/generated/lvrt_oracle/index.ts";
import * as vlt from "../src/generated/lvrt_vault/index.ts";
import * as fee from "../src/generated/lvrt_fee_router/index.ts";
import * as insIx from "../src/generated/lvrt_insurance/instructions/index.ts";
import {
  CUSTODY_COUNT,
  LVRT_MARKET_ID,
  ONCHAIN_MARKETS,
  type OnchainFamily,
  SHARDS,
} from "../src/data/onchain-markets.ts";
import { markets as referenceMarkets } from "../src/data/leveret.ts";
import {
  type BucketName,
  ENGINE,
  FEE_ROUTER,
  INSURANCE,
  ORACLE,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VAULT,
  engine,
  insurance,
  oracle,
  programData,
  router,
  vault,
} from "../src/lib/chain/pdas.ts";
import {
  CLUSTER,
  KEYS,
  devKey,
  exists,
  loadSigner,
  deployerPath,
  rpc,
  send,
  usdc,
} from "./lib.ts";

/** Test clusters can't afford a sub-second pusher, and wallets take seconds to
 *  approve: quotes stay valid for a minute here (mainnet: 800 ms / 2 s). */
const TEST_FRESH_MS = 60_000n;
const SOURCE = {
  Chainlink: 0,
  Switchboard: 1,
  Enclave: 2,
  PythPro: 3,
} as const;
const BUCKETS: BucketName[] = ["Core", "Stocks", "Factors"];
const BUCKET_MAX_OI = usdc(10_000_000);
const SEED_LIQUIDITY = usdc(1_000_000);

const familyOf: Record<OnchainFamily, eng.Family> = {
  Core: eng.Family.Core,
  Stocks: eng.Family.Stocks,
  Factors: eng.Family.Factors,
};
const bucketOf: Record<BucketName, eng.Bucket> = {
  Core: eng.Bucket.Core,
  Stocks: eng.Bucket.Stocks,
  SmallCap: eng.Bucket.SmallCap,
  Squared: eng.Bucket.Squared,
  Factors: eng.Bucket.Factors,
  Tickets: eng.Bucket.Tickets,
};

function riskFor(family: OnchainFamily, maxLev: number): eng.RiskParamsArgs {
  const base = {
    oiCapLong: 1_000_000n * 1_000_000n,
    oiCapShort: 1_000_000n * 1_000_000n,
    wideSpreadBps: 50,
    kBandBps: 5_000,
    maxPremiumBps: 100,
    skewScale: 100_000n * 1_000_000n,
    bandRefBps: 50,
    bandLimitBps: 200,
    feeTenthBps: 60,
    liqBountyCap: usdc(1_000),
  };
  if (family === "Core")
    return {
      ...base,
      maxLevX100: maxLev * 100,
      offHoursLevX100: maxLev * 100,
      mmBps: 100,
      mmOffHoursBps: 100,
      maxPositionNotional: usdc(50_000),
      baseSpreadBps: 5,
      offHoursSpreadBps: 5,
    };
  if (family === "Stocks")
    return {
      ...base,
      maxLevX100: 1_000,
      offHoursLevX100: 500,
      mmBps: 250,
      mmOffHoursBps: 500,
      maxPositionNotional: usdc(25_000),
      baseSpreadBps: 8,
      offHoursSpreadBps: 20,
    };
  return {
    ...base,
    maxLevX100: 500,
    offHoursLevX100: 0,
    mmBps: 400,
    mmOffHoursBps: 800,
    maxPositionNotional: usdc(10_000),
    baseSpreadBps: 10,
    offHoursSpreadBps: 10,
    feeTenthBps: 100,
  };
}

const symbolBytes = (s: string) => {
  const b = new Uint8Array(16);
  b.set(new TextEncoder().encode(s).slice(0, 16));
  return b;
};

async function step(
  label: string,
  done: boolean,
  ixs: () => Promise<Instruction[]>,
  payer: KeyPairSigner,
) {
  if (done) {
    console.log(`  · ${label} (exists)`);
    return;
  }
  await send(payer, await ixs(), label);
}

async function createMint(
  payer: KeyPairSigner,
  mint: KeyPairSigner,
  decimals: number,
  label: string,
) {
  const space = BigInt(getMintSize());
  const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
  await step(
    label,
    await exists(mint.address),
    async () => [
      getCreateAccountInstruction({
        payer,
        newAccount: mint,
        lamports: rent,
        space,
        programAddress: TOKEN_PROGRAM,
      }),
      getInitializeMintInstruction({
        mint: mint.address,
        decimals,
        mintAuthority: payer.address,
      }),
    ],
    payer,
  );
}

async function ata(
  owner: Address,
  mint: Address,
  tokenProgram = TOKEN_PROGRAM,
) {
  return (await findAssociatedTokenPda({ owner, mint, tokenProgram }))[0];
}

async function main() {
  console.log(`Bootstrapping Leveret on ${CLUSTER}`);
  const deployer = await loadSigner(deployerPath());
  const usdcMint = await loadSigner(resolve(KEYS, "test-usdc-mint.json"));
  const lvrtMint = await devKey("test-lvrt-mint");
  const pusherA = await devKey("dev-pusher-a");
  const pusherB = await devKey("dev-pusher-b");
  const enclave = await devKey("dev-enclave");
  const d = deployer.address;
  console.log(`  deployer ${d}\n  test USDC ${usdcMint.address}`);

  // -------------------------------------------------------------- mints
  console.log("Mints");
  await createMint(deployer, usdcMint, 6, "test USDC mint");
  await createMint(deployer, lvrtMint, 6, "test $LVRT mint");
  const deployerUsdc = await ata(d, usdcMint.address);
  await step(
    "deployer USDC account",
    await exists(deployerUsdc),
    async () => [
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: deployer,
        owner: d,
        mint: usdcMint.address,
      }),
      getMintToInstruction({
        mint: usdcMint.address,
        token: deployerUsdc,
        mintAuthority: deployer,
        amount: SEED_LIQUIDITY * BigInt(BUCKETS.length) + usdc(100_000),
      }),
    ],
    deployer,
  );

  // ------------------------------------------------------------- oracle
  console.log("Oracle");
  await step(
    "oracle initialize",
    await exists(await oracle.config()),
    async () => [
      orc.getInitializeInstruction({
        payer: deployer,
        config: await oracle.config(),
        calendar: await oracle.calendar(),
        program: ORACLE,
        programData: await programData(ORACLE),
        authority: d,
        guardian: d,
      }),
    ],
    deployer,
  );
  const validUntil = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
  for (const [key, source, kind, label] of [
    [
      pusherA,
      SOURCE.Chainlink,
      orc.SignerKind.Pusher,
      "pusher A (Chainlink source)",
    ],
    [
      pusherB,
      SOURCE.Switchboard,
      orc.SignerKind.Pusher,
      "pusher B (Switchboard source)",
    ],
    [
      enclave,
      SOURCE.Enclave,
      orc.SignerKind.Enclave,
      "dev enclave (Small Caps / Factors)",
    ],
  ] as const) {
    await send(
      deployer,
      [
        orc.getRegisterSignerInstruction({
          payer: deployer,
          authority: deployer,
          config: await oracle.config(),
          signerKey: await oracle.signerKey(key.address),
          pubkey: key.address,
          kind,
          source,
          attestationHash: new Uint8Array(32).fill(7),
          tcbLevel: 1,
          validUntil,
        }),
      ],
      `register ${label}`,
    );
  }
  const feeds = [
    ...ONCHAIN_MARKETS.map((m) => ({
      id: m.id,
      symbol: m.symbol,
      family: m.family,
    })),
    { id: LVRT_MARKET_ID, symbol: "LVRT", family: "Core" as OnchainFamily },
  ];
  for (const f of feeds) {
    const enclaveOnly = f.family === "Factors";
    await step(
      `feed ${f.symbol} (#${f.id})`,
      await exists(await oracle.feed(f.id)),
      async () => [
        orc.getCreateFeedInstruction({
          payer: deployer,
          authority: deployer,
          config: await oracle.config(),
          feed: await oracle.feed(f.id),
          priceState: await oracle.price(f.id),
          params: {
            marketId: f.id,
            family: familyOf[f.family] as unknown as orc.Family,
            symbol: symbolBytes(f.symbol),
            allowedSources: enclaveOnly
              ? 1 << SOURCE.Enclave
              : (1 << SOURCE.Chainlink) | (1 << SOURCE.Switchboard),
            minSources: enclaveOnly ? 1 : 2,
            maxDevBps: 50,
            freshMs: TEST_FRESH_MS,
            bandLimitBps: 200,
            normalBandBps: 10,
            chainlinkFeedId: new Uint8Array(32),
            switchboardFeedId: new Uint8Array(32),
            minSourceDepthUsd: 1_000_000n,
            measuredSourceDepthUsd: 50_000_000n,
          },
        }),
      ],
      deployer,
    );
  }

  // ------------------------------------------------------------- engine
  console.log("Engine");
  await step(
    "engine initialize",
    await exists(await engine.config()),
    async () => [
      eng.getInitializeInstruction({
        payer: deployer,
        config: await engine.config(),
        engineSigner: await engine.signer(),
        usdcMint: usdcMint.address,
        program: ENGINE,
        programData: await programData(ENGINE),
        authority: d,
        guardian: d,
        caOperator: d,
        custodyCount: CUSTODY_COUNT,
      }),
    ],
    deployer,
  );
  for (let k = 0; k < CUSTODY_COUNT; k++) {
    await step(
      `custody ${k}`,
      await exists(await engine.custody(k)),
      async () => [
        eng.getInitCustodyInstruction({
          payer: deployer,
          config: await engine.config(),
          engineSigner: await engine.signer(),
          usdcMint: usdcMint.address,
          custody: await engine.custody(k),
          tokenProgram: TOKEN_PROGRAM,
          k,
        }),
      ],
      deployer,
    );
  }
  for (const m of ONCHAIN_MARKETS) {
    const maxLev =
      referenceMarkets.find((r) => r.symbol === m.symbol)?.maxLeverage ?? 10;
    await step(
      `market ${m.symbol}`,
      await exists(await engine.market(m.id)),
      async () => [
        eng.getCreateMarketInstruction({
          payer: deployer,
          authority: deployer,
          config: await engine.config(),
          market: await engine.market(m.id),
          fundingState: await engine.funding(m.id),
          priceState: await oracle.price(m.id),
          bucketRisk: await engine.bucketRisk(m.bucket),
          marketId: m.id,
          family: familyOf[m.family],
          bucket: bucketOf[m.bucket],
          freshMs: TEST_FRESH_MS,
          risk: riskFor(m.family, maxLev),
          funding: {
            maxVelocity: 10_000_000_000n,
            maxRate: 100_000_000_000n,
            imbalanceK: 0n,
            borrowBasePpm: 10,
            borrowSlopePpm: 100,
          },
          shards: SHARDS,
          guarded: false,
        }),
      ],
      deployer,
    );
    const missing: number[] = [];
    for (let k = 0; k < SHARDS; k++)
      if (!(await exists(await engine.shard(m.id, k)))) missing.push(k);
    for (let i = 0; i < missing.length; i += 4) {
      const batch = missing.slice(i, i + 4);
      await send(
        deployer,
        await Promise.all(
          batch.map(async (k) =>
            eng.getInitShardInstruction({
              payer: deployer,
              market: await engine.market(m.id),
              shard: await engine.shard(m.id, k),
              k,
            }),
          ),
        ),
        `  shards ${m.symbol} ${batch.join(",")}`,
      );
    }
  }
  await send(
    deployer,
    [
      eng.getSetAdlParamsInstruction({
        signer: deployer,
        config: await engine.config(),
        operator: d,
        triggerBps: 9_500,
        targetBps: 9_000,
      }),
    ],
    "ADL params (operator = deployer)",
  );

  // -------------------------------------------------- vault / insurance / router
  console.log("LLP vault, insurance, fee router");
  const lpPrograms = await Promise.all([VAULT, INSURANCE, FEE_ROUTER].map(exists));
  if (!lpPrograms.every(Boolean)) {
    console.log("  · skipped: lvrt_vault / lvrt_insurance / lvrt_fee_router are not all deployed yet (trading works without them)");
    console.log("Done.");
    return;
  }
  const engineSigner = await engine.signer();
  await step(
    "vault initialize",
    await exists(await vault.config()),
    async () => [
      vlt.getInitializeInstruction({
        payer: deployer,
        config: await vault.config(),
        usdcMint: usdcMint.address,
        program: VAULT,
        programData: await programData(VAULT),
        authority: d,
        guardian: d,
        engineSigner,
        insuranceProgram: INSURANCE,
        feeRouterProgram: FEE_ROUTER,
      }),
    ],
    deployer,
  );
  await step(
    "insurance initialize",
    await exists(await insurance.config()),
    async () => [
      insIx.getInitializeInstruction({
        payer: deployer,
        config: await insurance.config(),
        usdcMint: usdcMint.address,
        lvrtMint: lvrtMint.address,
        program: INSURANCE,
        programData: await programData(INSURANCE),
        authority: d,
        guardian: d,
        engineSigner,
        lvrtPriceState: await oracle.price(LVRT_MARKET_ID),
        feeRouterProgram: FEE_ROUTER,
      }),
    ],
    deployer,
  );
  await step(
    "fee router initialize",
    await exists(await router.config()),
    async () => [
      fee.getInitializeInstruction({
        payer: deployer,
        config: await router.config(),
        routerSigner: await router.signer(),
        usdcMint: usdcMint.address,
        burnVault: await router.burnVault(),
        program: FEE_ROUTER,
        programData: await programData(FEE_ROUTER),
        tokenProgram: TOKEN_PROGRAM,
        authority: d,
        treasury: deployerUsdc,
      }),
    ],
    deployer,
  );

  for (const b of BUCKETS) {
    const bucket = bucketOf[b];
    const fresh = !(await exists(await vault.bucket(b)));
    await step(
      `LLP bucket ${b}`,
      !fresh,
      async () => [
        vlt.getCreateBucketInstruction({
          payer: deployer,
          authority: deployer,
          config: await vault.config(),
          bucketState: await vault.bucket(b),
          lpMint: await vault.lpMint(b),
          lpEscrow: await vault.lpEscrow(b),
          usdcMint: usdcMint.address,
          usdcVault: await vault.usdcVault(b),
          lpTokenProgram: TOKEN_2022_PROGRAM,
          usdcTokenProgram: TOKEN_PROGRAM,
          bucket: bucket as unknown as vlt.Bucket,
          maxOi: BUCKET_MAX_OI,
          utilizationCapBps: 8_000,
        }),
      ],
      deployer,
    );
    if (fresh) {
      // NAV is only fresh right after creation: seed LP capital now
      const lp = await ata(d, await vault.lpMint(b), TOKEN_2022_PROGRAM);
      await send(
        deployer,
        [
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: deployer,
            owner: d,
            mint: await vault.lpMint(b),
            tokenProgram: TOKEN_2022_PROGRAM,
          }),
          vlt.getDepositInstruction({
            depositor: deployer,
            bucketState: await vault.bucket(b),
            lpMint: await vault.lpMint(b),
            lpEscrow: await vault.lpEscrow(b),
            depositorLp: lp,
            usdcMint: usdcMint.address,
            depositorUsdc: deployerUsdc,
            usdcVault: await vault.usdcVault(b),
            lpTokenProgram: TOKEN_2022_PROGRAM,
            usdcTokenProgram: TOKEN_PROGRAM,
            amount: SEED_LIQUIDITY,
            minShares: 1n,
          }),
        ],
        `  seed ${b} bucket with ${Number(SEED_LIQUIDITY) / 1e6} USDC`,
      );
    }
    await step(
      `insurance fund ${b}`,
      await exists(await insurance.fund(b)),
      async () => [
        insIx.getCreateFundInstruction({
          payer: deployer,
          authority: deployer,
          config: await insurance.config(),
          fund: await insurance.fund(b),
          usdcMint: usdcMint.address,
          lvrtMint: lvrtMint.address,
          usdcVault: await insurance.usdcVault(b),
          stakeVault: await insurance.stakeVault(b),
          slashEscrow: await insurance.slashEscrow(b),
          usdcTokenProgram: TOKEN_PROGRAM,
          lvrtTokenProgram: TOKEN_PROGRAM,
          bucket: bucket as never,
          maxOi: BUCKET_MAX_OI,
        }),
      ],
      deployer,
    );
    await step(
      `fee inbox ${b}`,
      await exists(await router.inbox(b)),
      async () => [
        fee.getInitInboxInstruction({
          payer: deployer,
          config: await router.config(),
          routerSigner: await router.signer(),
          usdcMint: usdcMint.address,
          inbox: await router.inbox(b),
          tokenProgram: TOKEN_PROGRAM,
          bucket: bucket as unknown as fee.Bucket,
        }),
      ],
      deployer,
    );
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
