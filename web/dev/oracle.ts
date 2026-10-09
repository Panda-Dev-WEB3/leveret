// Dev oracle + faucet for test clusters. Stands in for the oracle-pusher
// service (Backend §13): signs PriceMsg reports with the registered pusher /
// enclave keys, serves them to the dashboard (which embeds them in its own
// transactions), periodically posts them on-chain, and runs the shard-merge
// crank, the TP/SL keeper, the ticket knock-out keeper and a QuoteAMM
// arbitrageur that keeps the Squared pools on their index. Also a test-USDC
// faucet.
//
//   LVRT_CLUSTER=localnet node web/dev/oracle.ts      # http://127.0.0.1:8787
//
// GET  /quotes            latest signed quote per market
// GET  /quote/<marketId>  one market
// POST /faucet {"owner"}  1,000 test USDC (+2 SOL on localnet)
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { type Address, type KeyPairSigner, address, airdropFactory, getBase58Decoder, getBase64Encoder, lamports, signBytes } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getMintToInstruction,
} from '@solana-program/token';
import * as eng from '../src/generated/lvrt_engine/index.ts';
import * as orc from '../src/generated/lvrt_oracle/index.ts';
import * as pw from '../src/generated/lvrt_power/index.ts';
import * as tk from '../src/generated/lvrt_tickets/index.ts';
import { POWER_MARKETS, type PowerProduct } from '../src/data/onchain-products.ts';
import { AMM_BAND_SESSION_BPS, ammSell, barrierOn, effectiveIndex, isKnockedOut, positionValue, powerIndex, usdcForTokens } from '../src/lib/chain/product-math.ts';
import { LVRT_MARKET_ID, ONCHAIN_MARKETS, SHARDS } from '../src/data/onchain-markets.ts';
import { markets as referenceMarkets } from '../src/data/leveret.ts';
import { ENGINE, IX_SYSVAR, TICKETS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, engine, oracle, power, shardFor, tickets } from '../src/lib/chain/pdas.ts';
import { SESSION, type PriceMsg, type SignedMessage, ed25519Instruction, encodePriceMsg, toQuoteJson, type QuoteJson } from '../src/lib/chain/price-msg.ts';
import { CLUSTER, KEYS, deployerPath, devKey, loadSigner, rpc, rpcSubscriptions, send, sleep, usdc } from './lib.ts';

const PORT = Number(process.env.LVRT_ORACLE_PORT ?? 8787);
/** How often to post every market on-chain and merge shards. Devnet SOL is
 *  scarce, so it posts rarely there; users' own trades post inline anyway. */
const PUSH_EVERY_MS = Number(process.env.LVRT_PUSH_EVERY_MS ?? (CLUSTER === 'devnet' ? 120_000 : 10_000));
const TICK_MS = 1_000;
const FAUCET_USDC = usdc(1_000);
const FAUCET_COOLDOWN_MS = 10 * 60_000;

type Feed = { id: number; symbol: string; enclave: boolean; price: number; halfSpreadBps: number };

const feeds: Feed[] = [
  ...ONCHAIN_MARKETS.map((m) => {
    const ref = referenceMarkets.find((r) => r.symbol === m.symbol);
    return { id: m.id, symbol: m.symbol, enclave: m.family === 'Factors', price: ref?.price ?? 100, halfSpreadBps: Math.max(1, (ref?.spreadBps ?? 6) / 2) };
  }),
  { id: LVRT_MARKET_ID, symbol: 'LVRT', enclave: false, price: 2, halfSpreadBps: 5 },
];

const latest = new Map<number, { msg: PriceMsg; sigs: SignedMessage[]; json: QuoteJson }>();
const toFixed8 = (x: number) => BigInt(Math.round(x * 1e8));

async function sign(signer: KeyPairSigner, msg: PriceMsg): Promise<SignedMessage> {
  const message = encodePriceMsg(msg);
  const signature = new Uint8Array(await signBytes(signer.keyPair.privateKey, message));
  return { signer: signer.address, message, signature };
}

async function tick(pusherA: KeyPairSigner, pusherB: KeyPairSigner, enclave: KeyPairSigner) {
  const tsMs = BigInt(Date.now());
  for (const f of feeds) {
    // geometric random walk, ~1.5% hourly vol
    f.price *= Math.exp((Math.random() - 0.5) * 0.0009);
    const mid = toFixed8(f.price);
    const half = (mid * BigInt(Math.round(f.halfSpreadBps * 100))) / 1_000_000n;
    const base: PriceMsg = { marketId: f.id, mid, bid: mid - half, ask: mid + half, bandBps: f.enclave ? 10 : 0, tsMs, session: SESSION.Regular, halted: false, caFlags: 0 };
    const sigs = f.enclave ? [await sign(enclave, base)] : await Promise.all([sign(pusherA, base), sign(pusherB, base)]);
    latest.set(f.id, { msg: base, sigs, json: toQuoteJson(base, sigs) });
  }
}

async function postPrices(payer: KeyPairSigner, ids: number[]) {
  const ixs = [];
  const sigs = ids.flatMap((id) => latest.get(id)?.sigs ?? []);
  if (!sigs.length) return;
  ixs.push(ed25519Instruction(sigs));
  for (const id of ids) {
    const q = latest.get(id);
    if (!q) continue;
    const ix = orc.getPostPricesInstruction({ feed: await oracle.feed(id), priceState: await oracle.price(id), calendar: await oracle.calendar(), instructions: IX_SYSVAR });
    const remaining = await Promise.all(q.sigs.map(async (s) => ({ address: await oracle.signerKey(s.signer), role: 0 as const })));
    ixs.push({ ...ix, accounts: [...ix.accounts, ...remaining] });
  }
  await send(payer, ixs);
}

async function merge(payer: KeyPairSigner, id: number) {
  const ix = eng.getMergeShardsInstruction({ market: await engine.market(id), fundingState: await engine.funding(id), priceState: await oracle.price(id) });
  const shards = await Promise.all(Array.from({ length: SHARDS }, async (_, k) => ({ address: await engine.shard(id, k), role: 1 as const })));
  await send(payer, [{ ...ix, accounts: [...ix.accounts, ...shards] }]);
}

async function pushLoop(payer: KeyPairSigner) {
  for (;;) {
    const started = Date.now();
    try {
      const ids = feeds.map((f) => f.id);
      for (let i = 0; i < ids.length; i += 2) await postPrices(payer, ids.slice(i, i + 2));
      for (const m of ONCHAIN_MARKETS) await merge(payer, m.id);
      console.log(`[push] ${ids.length} feeds posted, ${ONCHAIN_MARKETS.length} markets merged in ${Date.now() - started} ms`);
    } catch (e) {
      console.error('[push]', (e as Error).message.split('\n').slice(0, 6).join('\n'));
    }
    await sleep(Math.max(1_000, PUSH_EVERY_MS - (Date.now() - started)));
  }
}

/** Trigger keeper (Backend §13 trigger-exec): run TP/SL through the engine's
 *  fill path when the signed quote crosses the trigger price. */
// public devnet RPC rate-limits getProgramAccounts scans hard
const KEEPER_EVERY_MS = CLUSTER === 'devnet' ? 15_000 : 3_000;
const inFlight = new Set<string>();

async function keeperLoop(keeper: KeyPairSigner) {
  const keeperMargin = await engine.margin(keeper.address);
  if (!(await eng.fetchMaybeMarginAccount(rpc, keeperMargin)).exists) {
    await send(keeper, [eng.getCreateMarginAccountInstruction({ owner: keeper, margin: keeperMargin, subId: 0 })], 'keeper margin account');
  }
  const dec = eng.getTriggerDecoder();
  const disc = getBase58Decoder().decode(eng.TRIGGER_DISCRIMINATOR);
  for (;;) {
    try {
      const res = await rpc
        .getProgramAccounts(ENGINE, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0n, bytes: disc as never, encoding: 'base58' } }] })
        .send();
      const now = Math.floor(Date.now() / 1000);
      for (const { pubkey, account } of res) {
        if (inFlight.has(pubkey)) continue;
        const t = dec.decode(getBase64Encoder().encode(account.data[0]));
        const q = latest.get(t.marketId);
        if (!q || Number(t.expiry) < now) continue;
        const long = t.side === eng.Side.Long;
        const tp = t.kind === eng.TriggerKind.TakeProfit;
        const hit = long === tp ? q.msg.mid >= t.triggerPx : q.msg.mid <= t.triggerPx;
        if (!hit) continue;
        const side = long ? 'Long' : 'Short';
        const position = await engine.position(t.margin, t.marketId, side);
        if (!(await eng.fetchMaybePosition(rpc, position)).exists) continue; // closed by hand; owner can cancel
        inFlight.add(pubkey);
        try {
          const post = orc.getPostPricesInstruction({ feed: await oracle.feed(t.marketId), priceState: await oracle.price(t.marketId), calendar: await oracle.calendar(), instructions: IX_SYSVAR });
          const keys = await Promise.all(q.sigs.map(async (sg) => ({ address: await oracle.signerKey(sg.signer), role: 0 as const })));
          await send(keeper, [
            ed25519Instruction(q.sigs),
            { ...post, accounts: [...post.accounts, ...keys] },
            eng.getExecuteTriggerInstruction({
              keeper,
              keeperMargin,
              trigger: pubkey,
              margin: t.margin,
              market: await engine.market(t.marketId),
              fundingState: await engine.funding(t.marketId),
              priceState: await oracle.price(t.marketId),
              shard: await engine.shard(t.marketId, shardFor(t.margin, SHARDS)),
              position,
              owner: t.owner,
            }),
          ]);
          console.log(`[keeper] ${tp ? 'take profit' : 'stop loss'} executed on market ${t.marketId} at ${(Number(q.msg.mid) / 1e8).toFixed(2)}`);
        } catch (e) {
          console.error('[keeper]', (e as Error).message.split(String.fromCharCode(10)).slice(0, 12).join(String.fromCharCode(10)));
        } finally {
          inFlight.delete(pubkey);
        }
      }
    } catch (e) {
      console.error('[keeper scan]', (e as Error).message);
    }
    await sleep(KEEPER_EVERY_MS);
  }
}

/** Ticket knock-out keeper (§9): any signed report crossing the barrier, as
 *  of its own day, knocks the ticket out; it is submitted as Ed25519 evidence
 *  so a late report still counts. */
const KNOCK_OUT_EVERY_MS = CLUSTER === 'devnet' ? 15_000 : 5_000;

async function knockOutLoop(keeper: KeyPairSigner, evidenceKey: Address) {
  const dec = tk.getTicketDecoder();
  const disc = getBase58Decoder().decode(tk.TICKET_DISCRIMINATOR);
  for (;;) {
    try {
      const res = await rpc
        .getProgramAccounts(TICKETS, { encoding: 'base64', commitment: 'confirmed', filters: [{ memcmp: { offset: 0n, bytes: disc as never, encoding: 'base58' } }] })
        .send();
      for (const { pubkey, account } of res) {
        if (inFlight.has(pubkey)) continue;
        const t = dec.decode(getBase64Encoder().encode(account.data[0]));
        const q = latest.get(t.marketId);
        if (!q || q.msg.tsMs < t.issuedAt * 1000n) continue;
        const side = t.side === tk.Side.Long ? 'Long' : 'Short';
        const f = barrierOn(t.fInitial, t.rate, t.issuedAt, q.msg.tsMs / 86_400_000n);
        if (!isKnockedOut(side, q.msg.mid, f)) continue;
        const sig = q.sigs.find((x) => x.signer === evidenceKey) ?? q.sigs[0];
        inFlight.add(pubkey);
        try {
          const ix = tk.getKnockOutInstruction({ market: await tickets.market(t.marketId), priceState: await oracle.price(t.marketId), ticket: pubkey, owner: t.owner, instructions: IX_SYSVAR });
          await send(keeper, [ed25519Instruction([sig]), { ...ix, accounts: [...ix.accounts, { address: await oracle.signerKey(sig.signer), role: 0 as const }] }]);
          console.log(`[knock-out] ${side} ticket on market ${t.marketId}: ${(Number(q.msg.mid) / 1e8).toFixed(2)} crossed ${(Number(f) / 1e8).toFixed(2)}`);
        } catch (e) {
          console.error('[knock-out]', (e as Error).message.split(String.fromCharCode(10)).slice(0, 8).join(String.fromCharCode(10)));
        } finally {
          inFlight.delete(pubkey);
        }
      }
    } catch (e) {
      console.error('[knock-out scan]', (e as Error).message);
    }
    await sleep(KNOCK_OUT_EVERY_MS);
  }
}

/** QuoteAMM arbitrageur. The index moves ~2× the underlying, so without
 *  arbitrage a pool drifts out of its ±1% band (buys above it are refused).
 *  Like a real arb it trades the pool back to the index along its own curve:
 *  buying (then burning the tokens against its ShortVault) when the pool is
 *  cheap, minting (≥ 220%) and selling when it is expensive. */
const ARB_EVERY_MS = CLUSTER === 'devnet' ? 60_000 : 10_000;
const ARB_TRIGGER_BPS = 30n;
const ARB_MINT_CR_BPS = 22_000n;

async function arbLoop(mm: KeyPairSigner, usdcMint: Address) {
  for (;;) {
    for (const p of POWER_MARKETS) {
      try {
        await arb(mm, usdcMint, p);
      } catch (e) {
        console.error(`[amm ${p.symbol}]`, (e as Error).message.split(String.fromCharCode(10)).slice(0, 6).join(String.fromCharCode(10)));
      }
    }
    await sleep(ARB_EVERY_MS);
  }
}

async function tokenBalance(a: Address): Promise<bigint> {
  try {
    return BigInt((await rpc.getTokenAccountBalance(a, { commitment: 'confirmed' }).send()).value.amount);
  } catch {
    return 0n;
  }
}

async function arb(mm: KeyPairSigner, usdcMint: Address, p: PowerProduct) {
  const q = latest.get(p.underlyingId);
  const market = await power.market(p.id);
  const m = await pw.fetchMaybePowerMarket(rpc, market, { commitment: 'confirmed' });
  if (!q || !m.exists || m.data.ammTokens === 0n) return;
  const { ammUsdc: x, ammTokens: y, normFactor: nf } = m.data;
  const index = powerIndex(q.msg.mid);
  const off = ((effectiveIndex(x, y, nf) - index) * 10_000n) / index;
  if (off < ARB_TRIGGER_BPS && off > -ARB_TRIGGER_BPS) return;

  // same k, reserves priced at the index: x'/y' = USDC per token
  const perToken = Number(positionValue(1_000_000n, nf, index)) / 1e6;
  const k = Number(x) * Number(y);
  const yTarget = BigInt(Math.floor(Math.sqrt(k / perToken)));
  const mint = await power.mint(p.id);
  const [mmPower] = await findAssociatedTokenPda({ owner: mm.address, mint, tokenProgram: TOKEN_2022_PROGRAM });
  const [mmUsdc] = await findAssociatedTokenPda({ owner: mm.address, mint: usdcMint, tokenProgram: TOKEN_PROGRAM });
  const accts = {
    market,
    priceState: await oracle.price(p.underlyingId),
    powerMint: mint,
    usdcMint,
    usdcVault: await power.usdcVault(p.id),
    powerTokenProgram: TOKEN_2022_PROGRAM,
    usdcTokenProgram: TOKEN_PROGRAM,
  };
  const trade = { ...accts, user: mm, userPower: mmPower, tokenVault: await power.tokenVault(p.id), userUsdc: mmUsdc };
  const short = { ...accts, owner: mm, shortVault: await power.shortVault(market, mm.address), ownerPower: mmPower, ownerUsdc: mmUsdc };
  const post = orc.getPostPricesInstruction({ feed: await oracle.feed(p.underlyingId), priceState: await oracle.price(p.underlyingId), calendar: await oracle.calendar(), instructions: IX_SYSVAR });
  const keys = await Promise.all(q.sigs.map(async (sg) => ({ address: await oracle.signerKey(sg.signer), role: 0 as const })));
  const priced = [ed25519Instruction(q.sigs), { ...post, accounts: [...post.accounts, ...keys] }];
  const topUp = async (amount: bigint) => ((await tokenBalance(mmUsdc)) < amount ? [getMintToInstruction({ mint: usdcMint, token: mmUsdc, mintAuthority: mm, amount: amount * 2n })] : []);

  if (yTarget < y) {
    // pool cheap: buy tokens back, burn them against the arb's own short
    const want = y - yTarget;
    const usdcIn = usdcForTokens(x, y, want, nf, index, AMM_BAND_SESSION_BPS);
    if (usdcIn === null) return;
    await send(mm, [...(await topUp(usdcIn)), ...priced, pw.getAmmBuyInstruction({ ...trade, usdcIn, minTokensOut: (want * 99n) / 100n })]);
    const v = await pw.fetchMaybeShortVault(rpc, short.shortVault, { commitment: 'confirmed' });
    const burn = [await tokenBalance(mmPower), v.exists ? v.data.minted : 0n].reduce((a, b) => (a < b ? a : b));
    if (burn > 0n) await send(mm, [pw.getBurnShortInstruction({ ...short, burnAmount: burn, collateralOut: 0n })]);
    console.log(`[amm ${p.symbol}] pool ${Number(off)} bps under the index: bought ${(Number(want) / 1e6).toFixed(4)} tokens, burned ${(Number(burn) / 1e6).toFixed(4)}`);
  } else {
    // pool expensive: mint what the wallet doesn't hold (≥ 220%) and sell
    const want = yTarget - y;
    const held = await tokenBalance(mmPower);
    const out = ammSell(x, y, want, nf, index, AMM_BAND_SESSION_BPS);
    if (out === null) return;
    if (held < want) {
      const mintAmount = want - held;
      const collateral = (positionValue(mintAmount, nf, index) * ARB_MINT_CR_BPS) / 10_000n + 1n;
      await send(mm, [...(await topUp(collateral)), ...priced, pw.getMintShortInstruction({ ...short, collateralIn: collateral, mintAmount })]);
      await send(mm, [pw.getAmmSellInstruction({ ...trade, tokensIn: want, minUsdcOut: (out * 99n) / 100n })]);
    } else {
      await send(mm, [...priced, pw.getAmmSellInstruction({ ...trade, tokensIn: want, minUsdcOut: (out * 99n) / 100n })]);
    }
    console.log(`[amm ${p.symbol}] pool ${Number(off)} bps over the index: sold ${(Number(want) / 1e6).toFixed(4)} tokens`);
  }
}

const lastFaucet = new Map<string, number>();
async function faucet(deployer: KeyPairSigner, usdcMint: Address, owner: Address) {
  const now = Date.now();
  if (now - (lastFaucet.get(owner) ?? 0) < FAUCET_COOLDOWN_MS) throw new Error('Faucet cooldown: try again in a few minutes.');
  lastFaucet.set(owner, now);
  if (CLUSTER === 'localnet') await airdropFactory({ rpc, rpcSubscriptions })({ recipientAddress: owner, lamports: lamports(2_000_000_000n), commitment: 'confirmed' });
  const [token] = await findAssociatedTokenPda({ owner, mint: usdcMint, tokenProgram: TOKEN_PROGRAM });
  await send(deployer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: deployer, owner, mint: usdcMint }),
    getMintToInstruction({ mint: usdcMint, token, mintAuthority: deployer, amount: FAUCET_USDC }),
  ]);
  return { usdc: Number(FAUCET_USDC) / 1e6, sol: CLUSTER === 'localnet' ? 2 : 0 };
}

async function main() {
  const deployer = await loadSigner(deployerPath());
  const usdcMint = (await loadSigner(resolve(KEYS, 'test-usdc-mint.json'))).address;
  const [pusherA, pusherB, enclave] = await Promise.all([devKey('dev-pusher-a'), devKey('dev-pusher-b'), devKey('dev-enclave')]);
  // continue the walk from what is on-chain, so a restart doesn't jump prices
  try {
    const states = await orc.fetchAllMaybePriceState(rpc, await Promise.all(feeds.map((f) => oracle.price(f.id))));
    states.forEach((ps, i) => {
      if (ps.exists && ps.data.mid > 0n) feeds[i].price = Number(ps.data.mid) / 1e8;
    });
  } catch (e) {
    console.error('[start] on-chain prices unavailable, walking from reference prices:', (e as Error).message.split(String.fromCharCode(10))[0]);
  }
  await tick(pusherA, pusherB, enclave);
  setInterval(() => tick(pusherA, pusherB, enclave).catch((e) => console.error('[tick]', e)), TICK_MS);
  void pushLoop(deployer);
  void keeperLoop(deployer).catch((e) => console.error('[keeper] stopped:', e));
  if ((await rpc.getAccountInfo(TICKETS, { encoding: 'base64' }).send()).value) void knockOutLoop(deployer, pusherA.address);
  if ((await rpc.getAccountInfo(await power.config(), { encoding: 'base64' }).send()).value) void arbLoop(deployer, usdcMint);

  const json = (res: import('node:http').ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'OPTIONS') return json(res, 204, null);
      if (req.method === 'GET' && url.pathname === '/quotes') return json(res, 200, { cluster: CLUSTER, quotes: [...latest.values()].map((q) => q.json) });
      const m = /^\/quote\/(\d+)$/.exec(url.pathname);
      if (req.method === 'GET' && m) {
        const q = latest.get(Number(m[1]));
        return q ? json(res, 200, q.json) : json(res, 404, { error: 'unknown market' });
      }
      if (req.method === 'POST' && url.pathname === '/faucet') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 1_000) throw new Error('body too large');
        }
        const owner = address(String(JSON.parse(body).owner ?? ''));
        return json(res, 200, await faucet(deployer, usdcMint, owner));
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 400, { error: (e as Error).message.split('\n')[0] });
    }
  }).listen(PORT, '127.0.0.1', () => console.log(`dev oracle on http://127.0.0.1:${PORT} (${CLUSTER}), pushing every ${PUSH_EVERY_MS / 1000}s`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
