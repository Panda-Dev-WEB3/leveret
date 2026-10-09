// The canonical signed price message (lvrt_common::sigverify::PriceMsg) and
// the native Ed25519 verify instruction that carries it into a transaction.
import { type Address, type Instruction, getAddressEncoder } from '@solana/kit';
import { ED25519_PROGRAM } from './pdas.ts';

export const PRICE_MSG_DOMAIN = new TextEncoder().encode('LVRTPX01');
export const PRICE_MSG_LEN = 8 + 4 + 8 * 3 + 2 + 8 + 1 + 1 + 1;

export const SESSION = { Regular: 0, Pre: 1, Post: 2, Overnight: 3, Closed: 4 } as const;

export interface PriceMsg {
  marketId: number;
  /** 1e8 */
  mid: bigint;
  bid: bigint;
  ask: bigint;
  bandBps: number;
  tsMs: bigint;
  session: number;
  halted: boolean;
  caFlags: number;
}

/** Borsh layout, field order as in the Rust struct. */
export function encodePriceMsg(m: PriceMsg): Uint8Array {
  const out = new Uint8Array(PRICE_MSG_LEN);
  const v = new DataView(out.buffer);
  out.set(PRICE_MSG_DOMAIN, 0);
  v.setUint32(8, m.marketId, true);
  v.setBigInt64(12, m.mid, true);
  v.setBigInt64(20, m.bid, true);
  v.setBigInt64(28, m.ask, true);
  v.setUint16(36, m.bandBps, true);
  v.setBigInt64(38, m.tsMs, true);
  out[46] = m.session;
  out[47] = m.halted ? 1 : 0;
  out[48] = m.caFlags;
  return out;
}

export function decodePriceMsg(b: Uint8Array): PriceMsg {
  if (b.length !== PRICE_MSG_LEN || PRICE_MSG_DOMAIN.some((x, i) => b[i] !== x)) throw new Error('not a PriceMsg');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    marketId: v.getUint32(8, true),
    mid: v.getBigInt64(12, true),
    bid: v.getBigInt64(20, true),
    ask: v.getBigInt64(28, true),
    bandBps: v.getUint16(36, true),
    tsMs: v.getBigInt64(38, true),
    session: b[46],
    halted: b[47] === 1,
    caFlags: b[48],
  };
}

export interface SignedMessage {
  signer: Address;
  message: Uint8Array;
  signature: Uint8Array;
}

/**
 * One Ed25519 verify instruction for any number of signatures. All offsets
 * point inside this instruction (`*_instruction_index = u16::MAX`), which is
 * the only form lvrt_common::sigverify accepts.
 */
export function ed25519Instruction(sigs: SignedMessage[]): Instruction {
  const HEADER = 2;
  const OFFSETS = 14;
  const SELF = 0xffff;
  let cursor = HEADER + OFFSETS * sigs.length;
  const placed = sigs.map((s) => {
    const pk = cursor;
    const sig = pk + 32;
    const msg = sig + 64;
    cursor = msg + s.message.length;
    return { s, pk, sig, msg };
  });
  const data = new Uint8Array(cursor);
  const v = new DataView(data.buffer);
  data[0] = sigs.length;
  placed.forEach(({ s, pk, sig, msg }, i) => {
    const o = HEADER + i * OFFSETS;
    for (const [j, val] of [sig, SELF, pk, SELF, msg, s.message.length, SELF].entries()) v.setUint16(o + j * 2, val, true);
    data.set(getAddressEncoder().encode(s.signer), pk);
    data.set(s.signature, sig);
    data.set(s.message, msg);
  });
  return { programAddress: ED25519_PROGRAM, accounts: [], data };
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Wire form served by the quote API. */
export interface QuoteJson {
  marketId: number;
  tsMs: string;
  mid: string;
  bid: string;
  ask: string;
  session: number;
  messages: { signer: string; message: string; signature: string }[];
}

export const toQuoteJson = (m: PriceMsg, sigs: SignedMessage[]): QuoteJson => ({
  marketId: m.marketId,
  tsMs: m.tsMs.toString(),
  mid: m.mid.toString(),
  bid: m.bid.toString(),
  ask: m.ask.toString(),
  session: m.session,
  messages: sigs.map((s) => ({ signer: s.signer, message: b64(s.message), signature: b64(s.signature) })),
});

export const fromQuoteJson = (q: QuoteJson): SignedMessage[] =>
  q.messages.map((m) => ({ signer: m.signer as Address, message: unb64(m.message), signature: unb64(m.signature) }));
