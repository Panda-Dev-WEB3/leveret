// Headless end-to-end for limit-open orders: a far buy limit is placed and
// cancelled (reserve released), then a marketable buy limit (0.2% over the
// ask) is filled by the dev oracle's limit keeper at or under its limit, and
// the position is closed. Not-yet-crossed limits are covered by limit_flow.rs.
// Needs the dev oracle running (quotes, faucet, keepers).
//
//   LVRT_CLUSTER=localnet node web/dev/e2e-limit.ts
import { LeveretClient } from '../src/lib/chain/client.ts';
import type { ConnectedWallet } from '../src/lib/chain/wallets.ts';
import { onchainBySymbol } from '../src/data/onchain-markets.ts';
import { CLUSTER, RPC_URL, devKey, sleep } from './lib.ts';

const QUOTE_API = process.env.LVRT_QUOTE_API ?? 'http://127.0.0.1:8787';
const usdcMint = (process.env.LVRT_USDC_MINT ?? 'H3tRv17bsBR3ccV5cT9nzt66uqm1wn66tT9rmAiAvrfi') as never;
const cfg = { cluster: CLUSTER, rpcUrl: RPC_URL, quoteApi: QUOTE_API, usdcMint, chain: `solana:${CLUSTER}` as const, testCluster: true, limitOrders: true };
const client = new LeveretClient(cfg);
const kp = await devKey(process.env.LVRT_E2E_KEY ?? 'e2e-limit');
const wallet: ConnectedWallet = { name: 'e2e', address: kp.address, keypair: kp, signTransaction: async () => { throw new Error('unused'); }, disconnect: async () => {} };
const sol = onchainBySymbol.get('SOL')!;

console.log(`trader ${kp.address} on ${CLUSTER}`);
const f = await fetch(`${QUOTE_API}/faucet`, { method: 'POST', body: JSON.stringify({ owner: kp.address }) });
console.log('faucet', f.status, await f.text());
await client.send(wallet, await client.depositIxs(kp.address, 500));
let a = await client.account(kp.address);
const free0 = a.collateral;
console.log(`deposit     margin ${a.collateral.toFixed(4)} USDC`);

// 1. far limit, then cancel: the reserve comes back
const mid = Number((await client.quote(sol.id)).mid) / 1e8;
await client.send(wallet, await client.placeLimitIxs(kp.address, sol, { side: 'Long', marginUsdc: 100, leverage: 5, limitPx: Math.round(mid * 0.8 * 100) / 100, isolated: false }));
a = await client.account(kp.address);
console.log(`far limit   ${a.limits.length} order(s) · reserved ${a.limits[0]?.reserved.toFixed(4)} · margin ${a.collateral.toFixed(4)}`);
if (a.limits.length !== 1 || Math.abs(a.collateral + a.limits[0].reserved - free0) > 1e-6) throw new Error('reserve not taken from margin');
await client.send(wallet, await client.cancelLimitIxs(kp.address, a.limits[0]));
a = await client.account(kp.address);
console.log(`cancelled   ${a.limits.length} order(s) · margin ${a.collateral.toFixed(4)}`);
if (a.limits.length || Math.abs(a.collateral - free0) > 1e-6) throw new Error('reserve not released');

// 2. a marketable limit: the keeper fills it on its next scan, never above the limit
const q = await client.quote(sol.id);
const limitPx = Math.round((Number(q.ask) / 1e8) * 1.002 * 100) / 100;
await client.send(wallet, await client.placeLimitIxs(kp.address, sol, { side: 'Long', marginUsdc: 100, leverage: 5, limitPx, isolated: false }));
console.log(`buy limit   at ${limitPx.toFixed(2)} (ask ${(Number(q.ask) / 1e8).toFixed(2)}); waiting for the keeper…`);
for (let i = 0; i < 24; i++) {
  a = await client.account(kp.address);
  if (a.positions.some((p) => p.symbol === 'SOL' && p.side === 'Long')) break;
  await sleep(5_000);
}
const p = a.positions.find((x) => x.symbol === 'SOL' && x.side === 'Long');
if (!p || a.limits.length) throw new Error('limit order was not filled within 2 minutes');
console.log(`filled      ${p.size.toFixed(4)} SOL @ ${p.entry.toFixed(4)} (limit ${limitPx.toFixed(2)}) · margin ${a.collateral.toFixed(4)}`);
if (p.entry > limitPx + 1e-9) throw new Error('filled above the limit');
await client.send(wallet, await client.closeIxs(kp.address, p, 1));
a = await client.account(kp.address);
console.log(`closed      positions ${a.positions.length} · margin ${a.collateral.toFixed(4)} USDC`);
console.log('e2e limit ok');
