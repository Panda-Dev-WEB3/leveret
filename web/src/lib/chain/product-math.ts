// Off-chain mirrors of crates/lvrt_math power.rs (QuoteAMM) and tickets.rs,
// in the same integer units and rounding, so the dashboard can quote what the
// programs will compute. Prices 1e8, USDC 1e6, token / ratio base units 1e6,
// norm factor 1e18, rates 1e12 per year.

export const PRICE_SCALE = 100_000_000n;
export const NORM_SCALE = 10n ** 18n;
const RATE_SCALE = 10n ** 12n;
const BPS = 10_000n;

export const AMM_FEE_BPS = 10n;
export const AMM_BAND_SESSION_BPS = 100n;
export const AMM_BAND_OFF_HOURS_BPS = 300n;
export const SHORT_MINT_CR_BPS = 20_000n;
export const SHORT_MAINTAIN_CR_BPS = 15_000n;

const divUp = (n: bigint, d: bigint) => (n + d - 1n) / d;
const bpsUp = (v: bigint, bps: bigint) => divUp(v * bps, BPS);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const abs = (a: bigint) => (a < 0n ? -a : a);

// ------------------------------------------------------------------ power

export const powerIndex = (s: bigint) => (s * s) / PRICE_SCALE;

export function ammBand(index: bigint, bandBps: bigint): [bigint, bigint] {
  const d = (index * bandBps) / BPS;
  return [index - d, index + d];
}

/** Index-equivalent price: `usdc · PRICE_SCALE · NORM / (tokens · nf)`. */
export const effectiveIndex = (usdc: bigint, tokens: bigint, nf: bigint) => (((usdc * PRICE_SCALE) / tokens) * NORM_SCALE) / nf;
const tokensAt = (usdc: bigint, price: bigint, nf: bigint) => (((usdc * PRICE_SCALE) / price) * NORM_SCALE) / nf;
const usdcAt = (tokens: bigint, price: bigint, nf: bigint) => (((tokens * price) / PRICE_SCALE) * nf) / NORM_SCALE;

/** USDC value of `balance` PowerTokens (or a short's debt). */
export const positionValue = (balance: bigint, nf: bigint, index: bigint) => (((balance * index) / PRICE_SCALE) * nf) / NORM_SCALE;

/** Tokens out for `usdcIn`, or null when the program would refuse it. */
export function ammBuy(x: bigint, y: bigint, usdcIn: bigint, nf: bigint, index: bigint, bandBps: bigint): bigint | null {
  if (x === 0n || y === 0n || usdcIn === 0n) return null;
  const net = usdcIn - bpsUp(usdcIn, AMM_FEE_BPS);
  const curve = y - divUp(x * y, x + net);
  if (curve <= 0n) return null;
  const eff = effectiveIndex(net, curve, nf);
  const [lo, hi] = ammBand(index, bandBps);
  if (eff > hi) return null;
  const out = eff < lo ? tokensAt(net, lo, nf) : curve;
  return out <= 0n || out >= y ? null : out;
}

/** USDC out for `tokensIn` after the fee, or null when refused. */
export function ammSell(x: bigint, y: bigint, tokensIn: bigint, nf: bigint, index: bigint, bandBps: bigint): bigint | null {
  if (x === 0n || y === 0n || tokensIn === 0n) return null;
  const curve = x - divUp(x * y, y + tokensIn);
  const [lo] = ammBand(index, bandBps);
  const gross = max(curve, usdcAt(tokensIn, lo, nf));
  const out = gross - bpsUp(gross, AMM_FEE_BPS);
  return out <= 0n || gross >= x ? null : out;
}

/** Smallest `usdcIn` that buys at least `tokens`, or null when no buy can. */
export function usdcForTokens(x: bigint, y: bigint, tokens: bigint, nf: bigint, index: bigint, bandBps: bigint): bigint | null {
  if (tokens <= 0n || tokens >= y) return null;
  const [lo] = ammBand(index, bandBps);
  // net USDC for the curve to release `tokens`, then at least the floor price
  const curveNet = divUp(x * tokens, y - tokens) + 1n;
  const floorNet = divUp(divUp(tokens * lo, PRICE_SCALE) * nf, NORM_SCALE) + 1n;
  let usdcIn = divUp(max(curveNet, floorNet) * BPS, BPS - AMM_FEE_BPS) + 1n;
  for (let i = 0; i < 8; i++) {
    const out = ammBuy(x, y, usdcIn, nf, index, bandBps);
    if (out === null) return null;
    if (out >= tokens) return usdcIn;
    usdcIn += usdcIn / 2_000n + 1n;
  }
  return null;
}

// ---------------------------------------------------------------- tickets

export type TicketSide = 'Long' | 'Short';
const SPREAD_MIN_BPS = 15n;
const SPREAD_MAX_BPS = 50n;

export const notional = (r: bigint, s: bigint) => (r * s) / PRICE_SCALE;

export function ticketValue(side: TicketSide, s: bigint, f: bigint, r: bigint): bigint {
  const diff = side === 'Long' ? s - f : f - s;
  return diff <= 0n ? 0n : (diff * r) / PRICE_SCALE;
}

export function ticketPrice(side: TicketSide, s: bigint, f: bigint, r: bigint, halfSpreadBps: bigint, spreadBps: bigint, gapPremium: bigint): bigint {
  const adj = (s * halfSpreadBps) / BPS;
  const sAsk = side === 'Long' ? s + adj : s - adj;
  const clamped = spreadBps < SPREAD_MIN_BPS ? SPREAD_MIN_BPS : spreadBps > SPREAD_MAX_BPS ? SPREAD_MAX_BPS : spreadBps;
  return ticketValue(side, sAsk, f, r) + bpsUp(abs(notional(r, s)), clamped) + gapPremium;
}

/** Barrier on UTC day `day` (lazy daily roll from the issue day). */
export function barrierOn(fInitial: bigint, annualRate: bigint, issuedAt: bigint, day: bigint): bigint {
  let d = day - issuedAt / 86_400n;
  let x = fInitial;
  for (; d > 0n; d--) x = x + (x * annualRate) / (RATE_SCALE * 365n);
  return x;
}

export const isKnockedOut = (side: TicketSide, s: bigint, f: bigint) => (side === 'Long' ? s <= f : s >= f);
