// Headless end-to-end for Squared and Tickets through the dashboard's own
// builders: SOL² long buy → sell, SOL² short open → close, SOL-T ticket buy →
// sell back. Needs the dev oracle running (quotes + faucet). The trader must
// not be the deployer (its ShortVault holds the AMM seed; the dev oracle's
// arbitrageur trades as the deployer).
//
//   LVRT_CLUSTER=devnet LVRT_QUOTE_API=http://127.0.0.1:8788 node web/dev/e2e-products.ts
import { LeveretClient } from '../src/lib/chain/client.ts';
import type { ConnectedWallet } from '../src/lib/chain/wallets.ts';
import { powerBySymbol, ticketBySymbol } from '../src/data/onchain-products.ts';
import * as pr from '../src/lib/chain/products.ts';
import { lamports } from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';
import { CLUSTER, RPC_URL, deployerPath, devKey, loadSigner, rpc, send, sleep } from './lib.ts';

const QUOTE_API = process.env.LVRT_QUOTE_API ?? 'http://127.0.0.1:8787';
const usdcMint = (process.env.LVRT_USDC_MINT ?? 'H3tRv17bsBR3ccV5cT9nzt66uqm1wn66tT9rmAiAvrfi') as never;
const cfg = { cluster: CLUSTER, rpcUrl: RPC_URL, quoteApi: QUOTE_API, usdcMint, chain: `solana:${CLUSTER}` as const, testCluster: true };
const client = new LeveretClient(cfg);
const kp = await devKey(process.env.LVRT_E2E_KEY ?? 'e2e-trader');
const wallet: ConnectedWallet = { name: 'e2e', address: kp.address, keypair: kp, signTransaction: async () => { throw new Error('unused'); }, disconnect: async () => {} };
const SLIP = 1;

const wUsdc = async () => (await client.account(kp.address)).usdcBalance;
const sol2 = powerBySymbol.get('SOL²')!;
const solT = ticketBySymbol.get('SOL-T')!;
const holding = async () => (await pr.holdings(client, kp.address)).power.find((h) => h.product.symbol === 'SOL²');

console.log(`trader ${kp.address} on ${CLUSTER}`);
const deployer = await loadSigner(deployerPath());
if (deployer.address === kp.address) throw new Error('Use a trader key other than the deployer (LVRT_E2E_KEY).');
// fees and rent (ticket, ShortVault, token accounts): devnet test SOL
const MIN_SOL = 50_000_000n;
if ((await rpc.getBalance(kp.address).send()).value < MIN_SOL) {
  try {
    await rpc.requestAirdrop(kp.address, lamports(500_000_000n)).send();
    for (let i = 0; i < 30 && (await rpc.getBalance(kp.address).send()).value < MIN_SOL; i++) await sleep(1_000);
  } catch {
    /* faucet rate-limited */
  }
  if ((await rpc.getBalance(kp.address).send()).value < MIN_SOL) {
    await send(deployer, [getTransferSolInstruction({ source: deployer, destination: kp.address, amount: 100_000_000n })], 'trader funded with 0.1 test SOL by the deployer');
  }
}
const f = await fetch(`${QUOTE_API}/faucet`, { method: 'POST', body: JSON.stringify({ owner: kp.address }) });
console.log('faucet', f.status, await f.text());
const start = await wUsdc();
console.log(`start       wallet ${start.toFixed(2)} USDC`);

// Squared long
const before = (await holding())?.tokens ?? 0n;
const buy = await pr.powerBuyIxs(client, kp.address, sol2, 100, SLIP);
await client.sendAll(wallet, buy.txs);
let h = await holding();
const bought = (h?.tokens ?? 0n) - before;
console.log(`SOL² buy    +${(Number(bought) / 1e6).toFixed(6)} tokens for 100 USDC (quoted ${(Number(buy.tokens) / 1e6).toFixed(6)}) · wallet ${(await wUsdc()).toFixed(2)}`);
if (bought <= 0n) throw new Error('no tokens bought');
await client.sendAll(wallet, await pr.powerSellIxs(client, kp.address, sol2, bought, SLIP));
console.log(`SOL² sell   wallet ${(await wUsdc()).toFixed(2)} USDC`);

// Squared short
const so = await pr.shortOpenIxs(client, kp.address, sol2, 100, SLIP);
await client.sendAll(wallet, so.txs);
h = await holding();
if (!h?.short) throw new Error('no short vault after open');
console.log(`SOL² short  minted ${(Number(h.short.minted) / 1e6).toFixed(6)} · collateral ${(Number(h.short.collateral) / 1e6).toFixed(2)} · wallet ${(await wUsdc()).toFixed(2)}`);
await client.sendAll(wallet, await pr.shortCloseIxs(client, kp.address, sol2, h, await wUsdc(), SLIP));
h = await holding();
if (h?.short) throw new Error('short still open');
console.log(`SOL² close  wallet ${(await wUsdc()).toFixed(2)} USDC · dust ${(Number(h?.tokens ?? 0n) / 1e6).toFixed(6)} tokens`);

// Ticket
const s = Number((await client.quote(solT.marketId)).mid) / 1e8;
const tb = await pr.ticketBuyIxs(client, kp.address, solT, { side: 'Long', budget: 50, barrier: Math.round(s * 0.9 * 100) / 100, slippagePct: SLIP });
await client.sendAll(wallet, tb.txs);
const tix = (await pr.holdings(client, kp.address)).tickets;
console.log(`SOL-T buy   ${tix.length} ticket(s) · r ${(Number(tb.r) / 1e6).toFixed(4)} at ${tb.price.toFixed(4)} USDC, KO ${(s * 0.9).toFixed(2)} · wallet ${(await wUsdc()).toFixed(2)}`);
const t = tix.find((x) => x.r === tb.r);
if (!t) throw new Error('ticket not found');
await client.sendAll(wallet, await pr.ticketSellIxs(client, kp.address, t, SLIP));
const left = (await pr.holdings(client, kp.address)).tickets.filter((x) => x.address === t.address).length;
console.log(`SOL-T sell  wallet ${(await wUsdc()).toFixed(2)} USDC · ticket closed: ${left === 0}`);
console.log(`net over the run: ${((await wUsdc()) - start).toFixed(2)} USDC (fees, spreads, AMM curve)`);
console.log('e2e products ok');
