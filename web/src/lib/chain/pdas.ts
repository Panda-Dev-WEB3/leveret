// Program-derived addresses, mirroring the seeds in crates/lvrt_common.
// Shared by the dashboard and the dev scripts so both derive identically.
import { type Address, type ReadonlyUint8Array, getAddressEncoder, getProgramDerivedAddress } from '@solana/kit';
import { LVRT_ENGINE_PROGRAM_ADDRESS } from '../../generated/lvrt_engine/index.ts';
import { LVRT_ORACLE_PROGRAM_ADDRESS } from '../../generated/lvrt_oracle/index.ts';
import { LVRT_VAULT_PROGRAM_ADDRESS } from '../../generated/lvrt_vault/index.ts';
import { LVRT_TICKETS_PROGRAM_ADDRESS } from '../../generated/lvrt_tickets/index.ts';
import { LVRT_POWER_PROGRAM_ADDRESS } from '../../generated/lvrt_power/index.ts';

export const ENGINE = LVRT_ENGINE_PROGRAM_ADDRESS;
export const ORACLE = LVRT_ORACLE_PROGRAM_ADDRESS;
export const VAULT = LVRT_VAULT_PROGRAM_ADDRESS;
export const TICKETS = LVRT_TICKETS_PROGRAM_ADDRESS;
export const POWER = LVRT_POWER_PROGRAM_ADDRESS;
export const INSURANCE = 'DwkxsoEc8sQBBqBovGsHBDvrmomdcPqy9aK2zFcUZxhQ' as Address;
export const FEE_ROUTER = 'GxQSsXZi4uYAieZWyMBvk8c7dBbkKUQWJ5CoHKUHUeQF' as Address;
export const GOV = '2CvejCR36zZzmKgtBBP6G9jpVQCwwZ1AUe355t1Bci2E' as Address;

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const SYSTEM_PROGRAM = '11111111111111111111111111111111' as Address;
export const IX_SYSVAR = 'Sysvar1nstructions1111111111111111111111111' as Address;
export const ED25519_PROGRAM = 'Ed25519SigVerify111111111111111111111111111' as Address;
export const BPF_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111' as Address;

const text = (s: string) => new TextEncoder().encode(s);
const addr = (a: Address) => getAddressEncoder().encode(a);
const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
};
const pda = async (program: Address, seeds: (Uint8Array | ReadonlyUint8Array)[]) => (await getProgramDerivedAddress({ programAddress: program, seeds }))[0];

export type BucketName = 'Core' | 'Stocks' | 'SmallCap' | 'Squared' | 'Factors' | 'Tickets';
export const BUCKET_ID: Record<BucketName, number> = { Core: 0, Stocks: 1, SmallCap: 2, Squared: 3, Factors: 4, Tickets: 5 };
export type SideName = 'Long' | 'Short';
export const SIDE_ID: Record<SideName, number> = { Long: 0, Short: 1 };

export const programData = (program: Address) => pda(BPF_UPGRADEABLE, [addr(program)]);

export const oracle = {
  config: () => pda(ORACLE, [text('config')]),
  calendar: () => pda(ORACLE, [text('calendar')]),
  feed: (id: number) => pda(ORACLE, [text('feed'), u32(id)]),
  price: (id: number) => pda(ORACLE, [text('price'), u32(id)]),
  signerKey: (key: Address) => pda(ORACLE, [text('signer'), addr(key)]),
};

export const engine = {
  config: () => pda(ENGINE, [text('config')]),
  signer: () => pda(ENGINE, [text('authority')]),
  custody: (k: number) => pda(ENGINE, [text('custody'), Uint8Array.of(k)]),
  market: (id: number) => pda(ENGINE, [text('mkt'), u32(id)]),
  funding: (id: number) => pda(ENGINE, [text('fund'), u32(id)]),
  shard: (id: number, k: number) => pda(ENGINE, [text('shard'), u32(id), Uint8Array.of(k)]),
  bucketRisk: (b: BucketName) => pda(ENGINE, [text('brisk'), Uint8Array.of(BUCKET_ID[b])]),
  margin: (owner: Address, sub = 0) => pda(ENGINE, [text('margin'), addr(owner), Uint8Array.of(sub)]),
  position: (margin: Address, id: number, side: SideName) => pda(ENGINE, [text('pos'), addr(margin), u32(id), Uint8Array.of(SIDE_ID[side])]),
  trigger: (margin: Address, nonce: bigint) => pda(ENGINE, [text('trig'), addr(margin), u64(nonce)]),
};

export const vault = {
  config: () => pda(VAULT, [text('config')]),
  bucket: (b: BucketName) => pda(VAULT, [text('bucket'), Uint8Array.of(BUCKET_ID[b])]),
  lpMint: (b: BucketName) => pda(VAULT, [text('lp_mint'), Uint8Array.of(BUCKET_ID[b])]),
  lpEscrow: (b: BucketName) => pda(VAULT, [text('withdrawal'), Uint8Array.of(BUCKET_ID[b])]),
  usdcVault: (b: BucketName) => pda(VAULT, [text('custody'), Uint8Array.of(BUCKET_ID[b])]),
};

export const insurance = {
  config: () => pda(INSURANCE, [text('config')]),
  fund: (b: BucketName) => pda(INSURANCE, [text('insurance'), Uint8Array.of(BUCKET_ID[b])]),
  usdcVault: (b: BucketName) => pda(INSURANCE, [text('custody'), Uint8Array.of(BUCKET_ID[b])]),
  stakeVault: (b: BucketName) => pda(INSURANCE, [text('stake'), Uint8Array.of(BUCKET_ID[b])]),
  slashEscrow: (b: BucketName) => pda(INSURANCE, [text('slashed'), Uint8Array.of(BUCKET_ID[b])]),
};

export const router = {
  config: () => pda(FEE_ROUTER, [text('config')]),
  signer: () => pda(FEE_ROUTER, [text('router')]),
  burnVault: () => pda(FEE_ROUTER, [text('router'), text('burn')]),
  inbox: (b: BucketName) => pda(FEE_ROUTER, [text('fee_inbox'), Uint8Array.of(BUCKET_ID[b])]),
};

export const tickets = {
  config: () => pda(TICKETS, [text('config')]),
  vault: () => pda(TICKETS, [text('custody')]),
  market: (id: number) => pda(TICKETS, [text('mkt'), u32(id)]),
  ticket: (owner: Address, nonce: bigint) => pda(TICKETS, [text('ticket'), addr(owner), u64(nonce)]),
};

export const power = {
  config: () => pda(POWER, [text('config')]),
  market: (id: number) => pda(POWER, [text('power'), u32(id)]),
  mint: (id: number) => pda(POWER, [text('power_mint'), u32(id)]),
  usdcVault: (id: number) => pda(POWER, [text('custody'), u32(id)]),
  tokenVault: (id: number) => pda(POWER, [text('power'), text('amm'), u32(id)]),
  shortVault: (market: Address, owner: Address) => pda(POWER, [text('short'), addr(market), addr(owner)]),
};

/** `shard_for` from lvrt_math: FNV-1a over the margin account's 32 bytes, mod `shards`. */
export function shardFor(margin: Address, shards: number): number {
  let h = 0xcbf29ce484222325n;
  for (const b of addr(margin)) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return Number(h % BigInt(Math.max(1, shards)));
}
