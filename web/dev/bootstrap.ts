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
  signBytes,
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
import * as tk from "../src/generated/lvrt_tickets/index.ts";
import * as pw from "../src/generated/lvrt_power/index.ts";
import { POWER_MARKETS, TICKET_MARKETS } from "../src/data/onchain-products.ts";
import { NORM_SCALE, PRICE_SCALE, positionValue, powerIndex } from "../src/lib/chain/product-math.ts";
import {
  type PriceMsg,
  type SignedMessage,
  SESSION,
  ed25519Instruction,
  encodePriceMsg,
} from "../src/lib/chain/price-msg.ts";
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
  IX_SYSVAR,
  ORACLE,
  POWER,
  SYSTEM_PROGRAM,
  TICKETS,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  VAULT,
  engine,
  insurance,
  oracle,
  power,
  programData,
  router,
  tickets,
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
  usd,
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
/** TICKETS bucket liquidity (the ticket vault pays sell-backs). */
const TICKET_LIQUIDITY = usdc(500_000);
/** USDC side of each Squared QuoteAMM; the token side is minted at 220%. */
const POWER_POOL_USDC = usdc(250_000);
const POWER_SEED_CR_BPS = 22_000n;

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

/** `[Ed25519][post_prices]` re-signing the feed's last on-chain mid (or the
 *  reference price) with a fresh timestamp, for setup steps that need a Live
 *  price. A newer post already on-chain wins; the program skips older ones. */
async function freshPrice(id: number, signers: KeyPairSigner[], fallback: number) {
  const ps = await orc.fetchMaybePriceState(rpc, await oracle.price(id));
  const mid = ps.exists && ps.data.mid > 0n ? ps.data.mid : usd(fallback);
  const half = mid / 2_000n;
  const msg: PriceMsg = {
    marketId: id,
    mid,
    bid: mid - half,
    ask: mid + half,
    bandBps: 0,
    tsMs: BigInt(Date.now() - 1_500),
    session: SESSION.Regular,
    halted: false,
    caFlags: 0,
  };
  const message = encodePriceMsg(msg);
  const sigs: SignedMessage[] = await Promise.all(
    signers.map(async (k) => ({
      signer: k.address,
      message,
      signature: new Uint8Array(await signBytes(k.keyPair.privateKey, message)),
    })),
  );
  const post = orc.getPostPricesInstruction({
    feed: await oracle.feed(id),
    priceState: await oracle.price(id),
    calendar: await oracle.calendar(),
    instructions: IX_SYSVAR,
  });
  const keys = await Promise.all(
    sigs.map(async (sg) => ({ address: await oracle.signerKey(sg.signer), role: 0 as const })),
  );
  return { ixs: [ed25519Instruction(sigs), { ...post, accounts: [...post.accounts, ...keys] }], mid };
}

async function balanceOf(token: Address): Promise<bigint> {
  try {
    return BigInt((await rpc.getTokenAccountBalance(token, { commitment: "confirmed" }).send()).value.amount);
  } catch {
    return 0n;
  }
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

  // ------------------------------------------------------------- tickets
  console.log("Tickets");
  if (!(await exists(TICKETS))) {
    console.log("  · skipped: lvrt_tickets is not deployed");
  } else {
    const ticketsConfig = await tickets.config();
    const ticketVault = await tickets.vault();
    await step(
      "tickets initialize",
      await exists(ticketsConfig),
      async () => [
        tk.getInitializeInstruction({
          payer: deployer,
          config: ticketsConfig,
          usdcMint: usdcMint.address,
          vault: ticketVault,
          program: TICKETS,
          programData: await programData(TICKETS),
          tokenProgram: TOKEN_PROGRAM,
          authority: d,
          guardian: d,
        }),
      ],
      deployer,
    );
    const have = await balanceOf(ticketVault);
    await step(
      `tickets vault liquidity (${Number(TICKET_LIQUIDITY) / 1e6} USDC)`,
      have >= TICKET_LIQUIDITY,
      async () => [
        getMintToInstruction({
          mint: usdcMint.address,
          token: ticketVault,
          mintAuthority: deployer,
          amount: TICKET_LIQUIDITY - have,
        }),
      ],
      deployer,
    );
    for (const t of TICKET_MARKETS) {
      const market = await tickets.market(t.marketId);
      await step(
        `ticket market ${t.symbol}`,
        await exists(market),
        async () => [
          tk.getCreateTicketMarketInstruction({
            payer: deployer,
            authority: deployer,
            config: ticketsConfig,
            market,
            priceState: await oracle.price(t.marketId),
            marketId: t.marketId,
            freshMs: TEST_FRESH_MS,
            baseRate: 50_000_000_000n, // 5%/yr
            spreadLong: 20_000_000_000n,
            spreadShort: 20_000_000_000n,
            spreadBps: referenceMarkets.find((r) => r.symbol === t.symbol)?.spreadBps ?? 20,
            halfSpreadBps: 5,
            gapPremiumBps: 10,
            gapPremiumOffHoursBps: 50,
            netCapBps: 10_000,
            grossCap: usdc(1_000_000),
          }),
        ],
        deployer,
      );
    }
  }

  // ----------------------------------------------------- squared (power)
  console.log("Squared (lvrt_power)");
  if (!(await exists(POWER))) {
    console.log("  · skipped: lvrt_power is not deployed");
  } else {
    const powerConfig = await power.config();
    await step(
      "power initialize",
      await exists(powerConfig),
      async () => [
        pw.getInitializeInstruction({
          payer: deployer,
          config: powerConfig,
          program: POWER,
          programData: await programData(POWER),
          authority: d,
          guardian: d,
        }),
      ],
      deployer,
    );
    for (const p of POWER_MARKETS) {
      const market = await power.market(p.id);
      await step(
        `power market ${p.symbol}`,
        await exists(market),
        async () => [
          pw.getCreatePowerMarketInstruction({
            payer: deployer,
            authority: deployer,
            config: powerConfig,
            market,
            priceState: await oracle.price(p.underlyingId),
            powerMint: await power.mint(p.id),
            usdcMint: usdcMint.address,
            usdcVault: await power.usdcVault(p.id),
            tokenVault: await power.tokenVault(p.id),
            powerTokenProgram: TOKEN_2022_PROGRAM,
            usdcTokenProgram: TOKEN_PROGRAM,
            id: p.id,
            kind: pw.PowerKind.Squared,
            priceState2: SYSTEM_PROGRAM,
          }),
        ],
        deployer,
      );
      // QuoteAMM inventory: the deployer mints PowerTokens through its own
      // ShortVault (so every token is backed) and seeds the pool at the index.
      const m = await pw.fetchPowerMarket(rpc, market);
      if (m.data.ammTokens > 0n) {
        console.log(`  · ${p.symbol} AMM seeded (exists)`);
        continue;
      }
      const ref = referenceMarkets.find((r) => r.symbol === p.underlying)?.price ?? 100;
      const { ixs: priceIxs, mid } = await freshPrice(p.underlyingId, [pusherA, pusherB], ref);
      const index = powerIndex(mid);
      const nf = m.data.normFactor;
      const tokens = (((POWER_POOL_USDC * PRICE_SCALE) / index) * NORM_SCALE) / nf;
      const usdcIn = positionValue(tokens, nf, index);
      const collateral = (usdcIn * POWER_SEED_CR_BPS) / 10_000n + 1n;
      const bal = await balanceOf(deployerUsdc);
      if (bal < collateral + usdcIn) {
        await send(
          deployer,
          [
            getMintToInstruction({
              mint: usdcMint.address,
              token: deployerUsdc,
              mintAuthority: deployer,
              amount: collateral + usdcIn - bal,
            }),
          ],
          `deployer test USDC for the ${p.symbol} seed`,
        );
      }
      const powerMint = await power.mint(p.id);
      const deployerPower = await ata(d, powerMint, TOKEN_2022_PROGRAM);
      const shared = {
        market,
        priceState: await oracle.price(p.underlyingId),
        powerMint,
        usdcMint: usdcMint.address,
        usdcVault: await power.usdcVault(p.id),
        powerTokenProgram: TOKEN_2022_PROGRAM,
        usdcTokenProgram: TOKEN_PROGRAM,
      };
      await step(
        `deployer ${p.symbol} token account`,
        await exists(deployerPower),
        async () => [
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer: deployer,
            owner: d,
            mint: powerMint,
            tokenProgram: TOKEN_2022_PROGRAM,
          }),
        ],
        deployer,
      );
      // two signed prices + two Token-2022 instructions exceed one
      // transaction: mint with the fresh price, then seed against it
      await send(
        deployer,
        [
          ...priceIxs,
          pw.getMintShortInstruction({
            ...shared,
            owner: deployer,
            shortVault: await power.shortVault(market, d),
            ownerPower: deployerPower,
            ownerUsdc: deployerUsdc,
            collateralIn: collateral,
            mintAmount: tokens,
          }),
        ],
        `${p.symbol} seed tokens minted at ${Number(POWER_SEED_CR_BPS) / 100}%`,
      );
      await send(
        deployer,
        [
          pw.getSeedAmmInstruction({
            ...shared,
            authority: deployer,
            config: powerConfig,
            authorityPower: deployerPower,
            tokenVault: await power.tokenVault(p.id),
            authorityUsdc: deployerUsdc,
            usdcIn,
            tokensIn: tokens,
          }),
        ],
        `${p.symbol} AMM seeded: ${(Number(usdcIn) / 1e6).toLocaleString()} USDC + ${(Number(tokens) / 1e6).toFixed(4)} tokens at ${(Number(index) / 1e8).toFixed(2)} per token`,
      );
    }
  }

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
