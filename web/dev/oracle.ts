// Dev oracle + faucet for test clusters. Stands in for the oracle-pusher
// service (Backend §13): signs PriceMsg reports with the registered pusher /
// enclave keys, serves them to the dashboard (which embeds them in its own
// transactions), periodically posts them on-chain, and runs the shard-merge
// crank. Also a test-USDC faucet.
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
import { LVRT_MARKET_ID, ONCHAIN_MARKETS, SHARDS } from '../src/data/onchain-markets.ts';
import { markets as referenceMarkets } from '../src/data/leveret.ts';
import { ENGINE, IX_SYSVAR, TOKEN_PROGRAM, engine, oracle, shardFor } from '../src/lib/chain/pdas.ts';
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
const KEEPER_EVERY_MS = 3_000;
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
  await tick(pusherA, pusherB, enclave);
  setInterval(() => tick(pusherA, pusherB, enclave).catch((e) => console.error('[tick]', e)), TICK_MS);
  void pushLoop(deployer);
  void keeperLoop(deployer).catch((e) => console.error('[keeper] stopped:', e));

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
