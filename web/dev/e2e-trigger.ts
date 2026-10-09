// TP/SL check: open a long with a tight take-profit and stop-loss, then wait
// for the dev keeper to execute one of them.
//   LVRT_CLUSTER=localnet node web/dev/e2e-trigger.ts
import { LeveretClient } from '../src/lib/chain/client.ts';
import { onchainBySymbol } from '../src/data/onchain-markets.ts';
import type { ConnectedWallet } from '../src/lib/chain/wallets.ts';
import { CLUSTER, RPC_URL, devKey, sleep } from './lib.ts';

const QUOTE_API = process.env.LVRT_QUOTE_API ?? 'http://127.0.0.1:8787';
const cfg = { cluster: CLUSTER, rpcUrl: RPC_URL, quoteApi: QUOTE_API, usdcMint: 'H3tRv17bsBR3ccV5cT9nzt66uqm1wn66tT9rmAiAvrfi' as never, chain: `solana:${CLUSTER}` as const, testCluster: true };
const client = new LeveretClient(cfg);
const kp = await devKey('e2e-trigger');
const wallet: ConnectedWallet = { name: 'e2e', address: kp.address, keypair: kp, signTransaction: async () => { throw new Error('unused'); }, disconnect: async () => {} };

await fetch(`${QUOTE_API}/faucet`, { method: 'POST', body: JSON.stringify({ owner: kp.address }) });
await client.send(wallet, await client.depositIxs(kp.address, 300));
const eth = onchainBySymbol.get('ETH')!;
const open = await client.openIxs(kp.address, eth, { side: 'Long', marginUsdc: 100, leverage: 3, slippagePct: 0.5, isolated: false });
await client.send(wallet, open.ixs);
const mid = Number(open.quote.mid) / 1e8;
const tp = mid * 1.0004;
const sl = mid * 0.9996;
await client.send(wallet, await client.placeTriggerIxs(kp.address, eth.id, 'Long', open.size, { tp, sl, slippagePct: 1 }));
let a = await client.account(kp.address);
console.log(`ETH long ${open.size.toFixed(4)} @ ~${mid.toFixed(2)}; TP ${tp.toFixed(2)} SL ${sl.toFixed(2)}; triggers on-chain: ${a.triggers.map((t) => t.kind).join(', ')}`);

for (let i = 0; i < 40; i++) {
  await sleep(3_000);
  a = await client.account(kp.address);
  if (!a.positions.length) {
    console.log(`keeper closed the position after ~${(i + 1) * 3}s; triggers left: ${a.triggers.length}; collateral ${a.collateral.toFixed(4)}`);
    // cancel the other leg of the bracket
    for (const t of a.triggers) await client.send(wallet, await client.cancelTriggerIxs(kp.address, t));
    const b = await client.account(kp.address);
    console.log(`after cancelling the remaining leg: ${b.triggers.length} triggers`);
    console.log('trigger e2e ok');
    process.exit(0);
  }
}
console.error('keeper did not execute within 120s');
process.exit(1);
