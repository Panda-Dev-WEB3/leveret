// Squared (lvrt_power QuoteAMM + ShortVault) and Tickets (lvrt_tickets) for
// the dashboard: on-chain reads and transaction builders. Every trade carries
// the underlying's signed quote ([Ed25519][post_prices]) so the program prices
// against the same report the dashboard quoted from.
import { type Address, type Instruction, createNoopSigner, getBase58Decoder, getBase64Encoder } from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import * as pw from '../../generated/lvrt_power/index.ts';
import * as tk from '../../generated/lvrt_tickets/index.ts';
import { POWER_MARKETS, type PowerProduct, TICKET_MARKETS, type TicketProduct } from '../../data/onchain-products.ts';
import { TICKETS, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, power, oracle, tickets } from './pdas.ts';
import {
  AMM_BAND_SESSION_BPS,
  NORM_SCALE,
  PRICE_SCALE,
  type TicketSide,
  ammBuy,
  ammSell,
  barrierOn,
  notional,
  positionValue,
  powerIndex,
  ticketPrice,
  ticketValue,
  usdcForTokens,
} from './product-math.ts';
import { SESSION } from './price-msg.ts';
import type { LeveretClient } from './client.ts';

const TOKEN = 1_000_000n;
/** Reads that a trade is quoted from must see the latest confirmed state. */
const CONFIRMED = { commitment: 'confirmed' as const };
const BPS = 10_000n;
/** A short is opened with debt = 95% of the margin, so collateral (margin +
 *  debt) sits at ~205% of debt against the 200% mint floor. */
const SHORT_DEBT_OF_MARGIN_BPS = 9_500n;
const slipBps = (pct: number) => BigInt(Math.round(pct * 100));
const toUsdc = (n: number) => BigInt(Math.round(n * 1e6));

export interface LivePower {
  product: PowerProduct;
  ammUsdc: bigint;
  ammTokens: bigint;
  normFactor: bigint;
  /** carry, bps per day (positive = longs pay) */
  carryBpsDay: number;
}

export interface LiveTicketMarket {
  product: TicketProduct;
  m: tk.TicketMarket;
}

export interface PowerHolding {
  product: PowerProduct;
  tokens: bigint;
  short?: { collateral: bigint; minted: bigint };
}

export interface LiveTicket {
  address: Address;
  product: TicketProduct;
  side: TicketSide;
  r: bigint;
  fInitial: bigint;
  rate: bigint;
  issuedAt: bigint;
  notional: bigint;
}

export interface ProductsState {
  power: Map<string, LivePower>;
  tickets: Map<string, LiveTicketMarket>;
}

export interface Holdings {
  power: PowerHolding[];
  tickets: LiveTicket[];
}

/** USDC value per whole PowerToken at underlying price `s` (1e8). */
export const perToken = (p: LivePower, s: bigint) => Number(positionValue(TOKEN, p.normFactor, powerIndex(s))) / 1e6;
/** The AMM's quote per whole token (index-equivalent mark × nf). */
export const ammMark = (p: LivePower) => (p.ammTokens > 0n ? Number((p.ammUsdc * TOKEN) / p.ammTokens) / 1e6 : 0);
export const barrierNow = (t: LiveTicket) => barrierOn(t.fInitial, t.rate, t.issuedAt, BigInt(Math.floor(Date.now() / 86_400_000)));
export const ticketValueAt = (t: LiveTicket, s: bigint, halfSpreadBps: number) => {
  const adj = (s * BigInt(halfSpreadBps)) / BPS;
  return ticketValue(t.side, t.side === 'Long' ? s - adj : s + adj, barrierNow(t), t.r);
};

export async function productMarkets(c: LeveretClient): Promise<ProductsState> {
  const [pm, tm] = await Promise.all([
    pw.fetchAllMaybePowerMarket(c.rpc, await Promise.all(POWER_MARKETS.map((p) => power.market(p.id))), CONFIRMED),
    tk.fetchAllMaybeTicketMarket(c.rpc, await Promise.all(TICKET_MARKETS.map((t) => tickets.market(t.marketId))), CONFIRMED),
  ]);
  const out: ProductsState = { power: new Map(), tickets: new Map() };
  POWER_MARKETS.forEach((product, i) => {
    const m = pm[i];
    if (!m.exists) return;
    out.power.set(product.symbol, {
      product,
      ammUsdc: m.data.ammUsdc,
      ammTokens: m.data.ammTokens,
      normFactor: m.data.normFactor,
      carryBpsDay: (Number(m.data.funding) * 1e4) / 1e12,
    });
  });
  TICKET_MARKETS.forEach((product, i) => {
    const m = tm[i];
    if (m.exists) out.tickets.set(product.symbol, { product, m: m.data });
  });
  return out;
}

export async function holdings(c: LeveretClient, owner: Address): Promise<Holdings> {
  const powerAtas = await Promise.all(POWER_MARKETS.map(async (p) => (await findAssociatedTokenPda({ owner, mint: await power.mint(p.id), tokenProgram: TOKEN_2022_PROGRAM }))[0]));
  const vaults = await pw.fetchAllMaybeShortVault(c.rpc, await Promise.all(POWER_MARKETS.map(async (p) => power.shortVault(await power.market(p.id), owner))), CONFIRMED);
  // one call for every PowerToken account: SPL / Token-2022 amount is the u64 at offset 64
  const { value: accts } = await c.rpc.getMultipleAccounts(powerAtas, { encoding: 'base64', commitment: 'confirmed' }).send();
  const balances = accts.map((a) => {
    if (!a) return 0n;
    const b = getBase64Encoder().encode(a.data[0]);
    return b.length >= 72 ? new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(64, true) : 0n;
  });
  const powerOut: PowerHolding[] = [];
  POWER_MARKETS.forEach((product, i) => {
    const v = vaults[i];
    const short = v.exists && v.data.minted > 0n ? { collateral: v.data.collateral, minted: v.data.minted } : undefined;
    if (balances[i] > 0n || short) powerOut.push({ product, tokens: balances[i], short });
  });

  const res = await c.rpc
    .getProgramAccounts(TICKETS, {
      encoding: 'base64',
      commitment: 'confirmed',
      filters: [
        { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(tk.TICKET_DISCRIMINATOR) as never, encoding: 'base58' } },
        { memcmp: { offset: 8n, bytes: owner as never, encoding: 'base58' } },
      ],
    })
    .send();
  const dec = tk.getTicketDecoder();
  const byId = new Map(TICKET_MARKETS.map((t) => [t.marketId, t]));
  const ticketsOut: LiveTicket[] = [];
  for (const { pubkey, account } of res) {
    const t = dec.decode(getBase64Encoder().encode(account.data[0]));
    const product = byId.get(t.marketId);
    if (!product) continue;
    ticketsOut.push({ address: pubkey, product, side: t.side === tk.Side.Long ? 'Long' : 'Short', r: t.r, fInitial: t.fInitial, rate: t.rate, issuedAt: t.issuedAt, notional: t.notional });
  }
  ticketsOut.sort((a, b) => Number(b.issuedAt - a.issuedAt));
  return { power: powerOut, tickets: ticketsOut };
}

// ---------------------------------------------------------------- power

async function powerAccounts(c: LeveretClient, owner: Address, p: PowerProduct) {
  const market = await power.market(p.id);
  const mint = await power.mint(p.id);
  const [userPower] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM });
  const [userUsdc] = await findAssociatedTokenPda({ owner, mint: c.cfg.usdcMint, tokenProgram: TOKEN_PROGRAM });
  return {
    market,
    mint,
    userPower,
    userUsdc,
    priceState: await oracle.price(p.underlyingId),
    usdcVault: await power.usdcVault(p.id),
    tokenVault: await power.tokenVault(p.id),
  };
}

async function freshPower(c: LeveretClient, p: PowerProduct) {
  const { ixs, quote } = await c.priceIxs(p.underlyingId);
  const m = await pw.fetchPowerMarket(c.rpc, await power.market(p.id), CONFIRMED);
  if (m.data.ammTokens === 0n) throw new Error(`${p.symbol} has no AMM liquidity yet.`);
  const s = BigInt(quote.mid);
  return { ixs, m: m.data, index: powerIndex(s), off: quote.session !== SESSION.Regular };
}

const ammTrade = (c: LeveretClient, owner: Address, a: Awaited<ReturnType<typeof powerAccounts>>) => ({
  user: createNoopSigner(owner),
  market: a.market,
  priceState: a.priceState,
  powerMint: a.mint,
  userPower: a.userPower,
  tokenVault: a.tokenVault,
  usdcMint: c.cfg.usdcMint,
  userUsdc: a.userUsdc,
  usdcVault: a.usdcVault,
  powerTokenProgram: TOKEN_2022_PROGRAM,
  usdcTokenProgram: TOKEN_PROGRAM,
});

const shortAccounts = async (c: LeveretClient, owner: Address, a: Awaited<ReturnType<typeof powerAccounts>>) => ({
  owner: createNoopSigner(owner),
  market: a.market,
  priceState: a.priceState,
  shortVault: await power.shortVault(a.market, owner),
  powerMint: a.mint,
  ownerPower: a.userPower,
  usdcMint: c.cfg.usdcMint,
  ownerUsdc: a.userUsdc,
  usdcVault: a.usdcVault,
  powerTokenProgram: TOKEN_2022_PROGRAM,
  usdcTokenProgram: TOKEN_PROGRAM,
});

/** Create-ATA instruction only when the account is missing (keeps trade transactions small). */
async function ensureAta(c: LeveretClient, owner: Address, mint: Address, tokenProgram: Address): Promise<Instruction[]> {
  const [a] = await findAssociatedTokenPda({ owner, mint, tokenProgram });
  const { value } = await c.rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send();
  return value ? [] : [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: createNoopSigner(owner), owner, mint, tokenProgram })];
}

/** A flow as consecutive transactions: two signed prices plus two Token-2022
 *  instructions don't fit in one (1,232 bytes). Each price-dependent step that
 *  needs a fresh index carries the signed quote; follow-ups reuse the
 *  PriceState it just wrote. Empty steps are dropped. */
export type Txs = Instruction[][];
const txs = (...steps: Instruction[][]): Txs => steps.filter((s) => s.length > 0);

const outsideBand = (p: PowerProduct) =>
  new Error(`The ${p.symbol} AMM can't fill this inside the oracle band right now. Try a smaller amount, or wait for the pool to re-centre on the index.`);

/** Long: buy PowerTokens from the QuoteAMM with `usdc`. */
export async function powerBuyIxs(c: LeveretClient, owner: Address, p: PowerProduct, usdc: number, slippagePct: number): Promise<{ txs: Txs; tokens: bigint }> {
  const a = await powerAccounts(c, owner, p);
  const { ixs, m, index } = await freshPower(c, p);
  const usdcIn = toUsdc(usdc);
  const out = ammBuy(m.ammUsdc, m.ammTokens, usdcIn, m.normFactor, index, AMM_BAND_SESSION_BPS);
  if (out === null) throw outsideBand(p);
  const minTokensOut = (out * (BPS - slipBps(slippagePct))) / BPS;
  return { txs: txs(await ensureAta(c, owner, a.mint, TOKEN_2022_PROGRAM), [...ixs, pw.getAmmBuyInstruction({ ...ammTrade(c, owner, a), usdcIn, minTokensOut })]), tokens: out };
}

/** Close a long: sell `tokens` (default: the whole balance) back to the AMM. */
export async function powerSellIxs(c: LeveretClient, owner: Address, p: PowerProduct, tokens: bigint, slippagePct: number): Promise<Txs> {
  const a = await powerAccounts(c, owner, p);
  const { ixs, m, index } = await freshPower(c, p);
  const out = ammSell(m.ammUsdc, m.ammTokens, tokens, m.normFactor, index, AMM_BAND_SESSION_BPS);
  if (out === null) throw outsideBand(p);
  const minUsdcOut = (out * (BPS - slipBps(slippagePct))) / BPS;
  return txs(await ensureAta(c, owner, c.cfg.usdcMint, TOKEN_PROGRAM), [...ixs, pw.getAmmSellInstruction({ ...ammTrade(c, owner, a), tokensIn: tokens, minUsdcOut })]);
}

/** Short: mint PowerTokens against margin + the sale proceeds (~205%), then sell them. */
export async function shortOpenIxs(c: LeveretClient, owner: Address, p: PowerProduct, marginUsdc: number, slippagePct: number) {
  const a = await powerAccounts(c, owner, p);
  const { ixs, m, index, off } = await freshPower(c, p);
  if (off) throw new Error('Short minting is paused off-hours. Try again in the regular session.');
  const margin = toUsdc(marginUsdc);
  const debt = (margin * SHORT_DEBT_OF_MARGIN_BPS) / BPS;
  const mintAmount = (((debt * PRICE_SCALE) / index) * NORM_SCALE) / m.normFactor;
  const proceeds = ammSell(m.ammUsdc, m.ammTokens, mintAmount, m.normFactor, index, AMM_BAND_SESSION_BPS);
  if (proceeds === null || mintAmount === 0n) throw outsideBand(p);
  const sh = await shortAccounts(c, owner, a);
  return {
    txs: txs(
      await ensureAta(c, owner, a.mint, TOKEN_2022_PROGRAM),
      [...ixs, pw.getMintShortInstruction({ ...sh, collateralIn: margin + debt, mintAmount })],
      [pw.getAmmSellInstruction({ ...ammTrade(c, owner, a), tokensIn: mintAmount, minUsdcOut: (proceeds * (BPS - slipBps(slippagePct))) / BPS })],
    ),
    /** USDC the wallet must hold for a moment (margin + debt; the sale returns ~debt) */
    walletNeeds: Number(margin + debt) / 1e6,
  };
}

/** Close a short: free collateral above 150%, buy back the debt, burn it and withdraw the rest. */
export async function shortCloseIxs(c: LeveretClient, owner: Address, p: PowerProduct, h: PowerHolding, walletUsdc: number, slippagePct: number): Promise<Txs> {
  if (!h.short) throw new Error(`No ${p.symbol} short to close.`);
  const a = await powerAccounts(c, owner, p);
  const { ixs, m, index } = await freshPower(c, p);
  const sh = await shortAccounts(c, owner, a);
  const { collateral, minted } = h.short;
  const need = minted > h.tokens ? minted - h.tokens : 0n;
  const first: Instruction[] = [...ixs];
  const second: Instruction[] = [];
  let left = collateral;
  if (need > 0n) {
    const debtValue = positionValue(minted, m.normFactor, index);
    // keep 153% (150% floor + headroom for the price in the same tx)
    const keep = (debtValue * 15_300n) / BPS + 1n;
    const free = collateral > keep ? collateral - keep : 0n;
    const quoted = usdcForTokens(m.ammUsdc, m.ammTokens, need, m.normFactor, index, AMM_BAND_SESSION_BPS);
    if (quoted === null) throw outsideBand(p);
    const usdcIn = (quoted * (BPS + slipBps(slippagePct))) / BPS + 1n;
    if (Number(usdcIn) / 1e6 > walletUsdc + Number(free) / 1e6) throw new Error(`Buying back the debt needs ${(Number(usdcIn) / 1e6).toFixed(2)} USDC; the wallet plus free collateral can't cover it.`);
    if (free > 0n) {
      first.push(pw.getBurnShortInstruction({ ...sh, burnAmount: 0n, collateralOut: free }));
      left -= free;
    }
    second.push(pw.getAmmBuyInstruction({ ...ammTrade(c, owner, a), usdcIn, minTokensOut: need }));
  }
  second.push(pw.getBurnShortInstruction({ ...sh, burnAmount: minted, collateralOut: left }));
  return txs(first, second);
}

// -------------------------------------------------------------- tickets

/** Buy a knock-out ticket costing at most `budget` USDC. */
export async function ticketBuyIxs(c: LeveretClient, owner: Address, t: TicketProduct, a: { side: TicketSide; budget: number; barrier: number; slippagePct: number }) {
  const { ixs, quote } = await c.priceIxs(t.marketId);
  const mk = await tk.fetchTicketMarket(c.rpc, await tickets.market(t.marketId), CONFIRMED);
  if (mk.data.paused) throw new Error(`${t.symbol} is paused.`);
  const s = BigInt(quote.mid);
  const f = BigInt(Math.round(a.barrier * 1e8));
  const gapBps = BigInt(quote.session === SESSION.Regular ? mk.data.gapPremiumBps : mk.data.gapPremiumOffHoursBps);
  const priceOf = (r: bigint) => ticketPrice(a.side, s, f, r, BigInt(mk.data.halfSpreadBps), BigInt(mk.data.spreadBps), (notional(r, s) * gapBps) / BPS);
  const maxPrice = toUsdc(a.budget);
  // leave room for the on-chain price to move by the slippage limit
  const target = (maxPrice * (BPS - slipBps(a.slippagePct))) / BPS;
  const unit = priceOf(TOKEN);
  if (unit <= 0n) throw new Error('This knock-out level gives the ticket no value.');
  let r = (target * TOKEN) / unit;
  while (r > 0n && priceOf(r) > target) r = (r * 999n) / 1000n;
  if (r === 0n) throw new Error('The budget is too small for one ticket unit at this level.');
  if (notional(r, s) > 10_000n * 1_000_000n) throw new Error('Tickets are capped at 10,000 USDC notional before the audit.');
  const nonce = BigInt(Date.now());
  const [buyerUsdc] = await findAssociatedTokenPda({ owner, mint: c.cfg.usdcMint, tokenProgram: TOKEN_PROGRAM });
  const buy = tk.getBuyInstruction({
    buyer: createNoopSigner(owner),
    config: await tickets.config(),
    market: await tickets.market(t.marketId),
    priceState: await oracle.price(t.marketId),
    ticket: await tickets.ticket(owner, nonce),
    usdcMint: c.cfg.usdcMint,
    buyerUsdc,
    vault: await tickets.vault(),
    tokenProgram: TOKEN_PROGRAM,
    nonce,
    side: a.side === 'Long' ? tk.Side.Long : tk.Side.Short,
    r,
    barrier: f,
    maxPrice,
  });
  return { txs: txs([...ixs, buy]), price: Number(priceOf(r)) / 1e6, r };
}

/** Sell a ticket back at V(S_bid) (regular session only). */
export async function ticketSellIxs(c: LeveretClient, owner: Address, t: LiveTicket, slippagePct: number): Promise<Txs> {
  const { ixs, quote } = await c.priceIxs(t.product.marketId);
  if (quote.session !== SESSION.Regular) throw new Error('Tickets sell back in the regular session only.');
  const mk = await tk.fetchTicketMarket(c.rpc, await tickets.market(t.product.marketId), CONFIRMED);
  const out = ticketValueAt(t, BigInt(quote.mid), mk.data.halfSpreadBps);
  const [ownerUsdc] = await findAssociatedTokenPda({ owner, mint: c.cfg.usdcMint, tokenProgram: TOKEN_PROGRAM });
  return txs(await ensureAta(c, owner, c.cfg.usdcMint, TOKEN_PROGRAM), [
    ...ixs,
    tk.getSellBackInstruction({
      owner: createNoopSigner(owner),
      config: await tickets.config(),
      market: await tickets.market(t.product.marketId),
      priceState: await oracle.price(t.product.marketId),
      ticket: t.address,
      usdcMint: c.cfg.usdcMint,
      ownerUsdc,
      vault: await tickets.vault(),
      tokenProgram: TOKEN_PROGRAM,
      minOut: (out * (BPS - slipBps(slippagePct))) / BPS,
    }),
  ]);
}
