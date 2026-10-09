// Print each Squared pool's mark vs the index (debug helper).
import * as pw from '../src/generated/lvrt_power/index.ts';
import * as orc from '../src/generated/lvrt_oracle/index.ts';
import { POWER_MARKETS } from '../src/data/onchain-products.ts';
import { effectiveIndex, powerIndex } from '../src/lib/chain/product-math.ts';
import { oracle, power } from '../src/lib/chain/pdas.ts';
import { rpc } from './lib.ts';

const QUOTE_API = process.env.LVRT_QUOTE_API ?? 'http://127.0.0.1:8787';
for (const p of POWER_MARKETS) {
  const m = (await pw.fetchPowerMarket(rpc, await power.market(p.id))).data;
  const ps = (await orc.fetchPriceState(rpc, await oracle.price(p.underlyingId))).data;
  const q = (await (await fetch(`${QUOTE_API}/quote/${p.underlyingId}`)).json()) as { mid: string };
  const mark = effectiveIndex(m.ammUsdc, m.ammTokens, m.normFactor);
  const bps = (i: bigint) => Number(((mark - i) * 10_000n) / i);
  console.log(`${p.symbol.padEnd(6)} usdc ${(Number(m.ammUsdc) / 1e6).toFixed(0)} tokens ${(Number(m.ammTokens) / 1e6).toFixed(4)} · vs on-chain index ${bps(powerIndex(ps.mid))} bps · vs quote ${bps(powerIndex(BigInt(q.mid)))} bps · nf ${(Number(m.normFactor) / 1e18).toFixed(6)}`);
}
