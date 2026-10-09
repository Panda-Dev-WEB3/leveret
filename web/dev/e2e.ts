// End-to-end check of the dashboard's chain client against a running cluster
// + dev oracle: faucet → deposit → open → read → close → withdraw.
//   LVRT_CLUSTER=localnet node web/dev/e2e.ts
import { LeveretClient } from '../src/lib/chain/client.ts';
import { onchainBySymbol } from '../src/data/onchain-markets.ts';
import type { ConnectedWallet } from '../src/lib/chain/wallets.ts';
import { CLUSTER, RPC_URL, devKey } from './lib.ts';

const QUOTE_API = process.env.LVRT_QUOTE_API ?? 'http://127.0.0.1:8787';
const usdcMint = (process.env.LVRT_USDC_MINT ?? 'H3tRv17bsBR3ccV5cT9nzt66uqm1wn66tT9rmAiAvrfi') as never;

const cfg = { cluster: CLUSTER, rpcUrl: RPC_URL, quoteApi: QUOTE_API, usdcMint, chain: `solana:${CLUSTER}` as const, testCluster: true };
const client = new LeveretClient(cfg);
const kp = await devKey(process.env.LVRT_E2E_KEY ?? 'e2e-trader');
const wallet: ConnectedWallet = { name: 'e2e', address: kp.address, keypair: kp, signTransaction: async () => { throw new Error('unused'); }, disconnect: async () => {} };
const show = async (label: string) => {
  const a = await client.account(kp.address);
  console.log(`${label.padEnd(10)} wallet ${a.usdcBalance.toFixed(2)} USDC · ${a.solBalance.toFixed(3)} SOL | margin ${a.marginExists ? a.collateral.toFixed(4) : '—'} | positions ${a.positions.map((p) => `${p.symbol} ${p.side} ${p.size.toFixed(4)} @ ${p.entry.toFixed(2)}`).join(', ') || 'none'}`);
  return a;
};

console.log(`trader ${kp.address} on ${CLUSTER}`);
const f = await fetch(`${QUOTE_API}/faucet`, { method: 'POST', body: JSON.stringify({ owner: kp.address }) });
console.log('faucet', f.status, await f.text());
await show('start');

await client.send(wallet, await client.depositIxs(kp.address, 500));
await show('deposit');

const sol = onchainBySymbol.get('SOL')!;
const open = await client.openIxs(kp.address, sol, { side: 'Long', marginUsdc: 100, leverage: 5, slippagePct: 0.5, isolated: false });
const sig = await client.send(wallet, open.ixs);
console.log(`open sig ${sig.slice(0, 16)}… quote mid ${(Number(open.quote.mid) / 1e8).toFixed(2)}`);
let a = await show('open');

const live = (await client.markets()).get('SOL');
console.log('SOL on-chain', live?.onchain, 'OI', live?.funding);

await new Promise((r) => setTimeout(r, 11_000)); // past the anti-staleness window
await client.send(wallet, await client.closeIxs(kp.address, a.positions[0], 0.5));
a = await show('close');

await client.send(wallet, await client.withdrawIxs(kp.address, Math.floor(a.collateral * 100) / 100 - 1, a.positions));
await show('withdraw');
console.log('e2e ok');
