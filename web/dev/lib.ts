// Shared helpers for the dev stack (bootstrap, dev oracle, deploy checks).
// Runs on Node >= 22.18 / 24 with built-in TypeScript type stripping.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Address,
  type Instruction,
  type KeyPairSigner,
  type TransactionSigner,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit';
import { createRpc } from '../src/lib/chain/rpc.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, '../..');
export const KEYS = resolve(REPO, 'keys');

export type Cluster = 'localnet' | 'devnet';
export const CLUSTER = (process.env.LVRT_CLUSTER ?? 'localnet') as Cluster;
if (CLUSTER !== 'localnet' && CLUSTER !== 'devnet') throw new Error(`LVRT_CLUSTER must be localnet or devnet, got ${CLUSTER}`);

export const RPC_URL = process.env.LVRT_RPC_URL ?? (CLUSTER === 'devnet' ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899');
export const WS_URL = process.env.LVRT_WS_URL ?? (CLUSTER === 'devnet' ? 'wss://api.devnet.solana.com' : 'ws://127.0.0.1:8900');

export const rpc = createRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions(WS_URL);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

/** Load a Solana CLI keypair file (JSON array of 64 bytes). */
export async function loadSigner(path: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8'))));
}

/** Load `keys/<name>.json`, creating a fresh keypair file if it doesn't exist. */
export async function devKey(name: string): Promise<KeyPairSigner> {
  const path = resolve(KEYS, `${name}.json`);
  if (!existsSync(path)) {
    mkdirSync(KEYS, { recursive: true });
    const { webcrypto } = await import('node:crypto');
    const kp = (await webcrypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', kp.privateKey));
    const pub = new Uint8Array(await webcrypto.subtle.exportKey('raw', kp.publicKey));
    // PKCS#8 Ed25519: the 32-byte seed is the trailing 32 bytes
    writeFileSync(path, JSON.stringify([...pkcs8.slice(-32), ...pub]));
  }
  return loadSigner(path);
}

export const deployerPath = () => process.env.LVRT_DEPLOYER ?? resolve(KEYS, 'devnet-deployer.json');

export async function exists(a: Address): Promise<boolean> {
  const { value } = await rpc.getAccountInfo(a, { encoding: 'base64', commitment: 'confirmed' }).send();
  return value !== null;
}

/** Build, sign (fee payer + every signer attached to the instructions) and confirm. */
export async function send(feePayer: TransactionSigner, ixs: Instruction[], label = ''): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  try {
    await sendAndConfirm(tx as Parameters<typeof sendAndConfirm>[0], { commitment: 'confirmed' });
  } catch (e) {
    const logs = (e as { context?: { logs?: string[] }; cause?: { context?: { logs?: string[] } } });
    const lines = logs.context?.logs ?? logs.cause?.context?.logs ?? [];
    throw new Error(`${label || 'transaction'} failed: ${(e as Error).message}\n${lines.join('\n')}`);
  }
  const sig = getSignatureFromTransaction(tx);
  if (label) console.log(`  ✓ ${label}`);
  return sig;
}

export const usd = (n: number) => BigInt(Math.round(n * 1e8));
export const usdc = (n: number) => BigInt(Math.round(n * 1e6));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
