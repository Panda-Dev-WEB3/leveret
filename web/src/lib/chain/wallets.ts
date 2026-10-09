// Wallets via the Wallet Standard (Phantom, Solflare, Backpack, …), plus a
// burner key for localnet only. The dashboard hands a wallet unsigned
// transaction bytes and gets signed bytes back; it never sees a private key
// (except the localnet burner, which exists only in this browser).
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { type Address, type KeyPairSigner, createKeyPairSignerFromPrivateKeyBytes } from '@solana/kit';
import type { ChainConfig } from './config.ts';

export interface ConnectedWallet {
  name: string;
  address: Address;
  /** Sign serialized transaction bytes; returns the signed bytes. */
  signTransaction(bytes: Uint8Array): Promise<Uint8Array>;
  disconnect(): Promise<void>;
  /** Present only for the localnet burner. */
  keypair?: KeyPairSigner;
}

type SignFeature = {
  signTransaction(...inputs: { account: WalletAccount; transaction: Uint8Array; chain?: string }[]): Promise<{ signedTransaction: Uint8Array }[]>;
};
type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> };
type DisconnectFeature = { disconnect(): Promise<void> };

export interface WalletChoice {
  name: string;
  icon?: string;
  /** `silent` reconnects without a prompt (only if the wallet already trusts this site). */
  connect(silent?: boolean): Promise<ConnectedWallet>;
}

function supports(w: Wallet, cfg: ChainConfig | null) {
  if (!('standard:connect' in w.features) || !w.chains.some((c) => c.startsWith('solana:'))) return false;
  if (!cfg) return true; // reference mode: connect only
  return 'solana:signTransaction' in w.features && (cfg.cluster === 'localnet' || w.chains.includes(cfg.chain));
}

function fromStandard(w: Wallet, cfg: ChainConfig | null): WalletChoice {
  return {
    name: w.name,
    icon: w.icon,
    async connect(silent = false) {
      const { accounts } = await (w.features['standard:connect'] as ConnectFeature).connect(silent ? { silent: true } : undefined);
      const account = accounts[0];
      if (!account) throw new Error(`${w.name} did not share an account.`);
      const sign = w.features['solana:signTransaction'] as SignFeature | undefined;
      return {
        name: w.name,
        address: account.address as Address,
        async signTransaction(bytes) {
          if (!sign) throw new Error(`${w.name} cannot sign Solana transactions.`);
          const [out] = await sign.signTransaction({ account, transaction: bytes, chain: cfg?.chain });
          return out.signedTransaction;
        },
        async disconnect() {
          await (w.features['standard:disconnect'] as DisconnectFeature | undefined)?.disconnect();
        },
      };
    },
  };
}

const BURNER_KEY = 'leveret.localnet.burner.v1';

/** Localnet-only test wallet kept in localStorage. Never offered on devnet or mainnet. */
function burner(cfg: ChainConfig | null): WalletChoice | null {
  if (cfg?.cluster !== 'localnet') return null;
  return {
    name: 'Local test wallet',
    async connect() {
      let seed: Uint8Array;
      const saved = localStorage.getItem(BURNER_KEY);
      if (saved) seed = Uint8Array.from(JSON.parse(saved));
      else {
        seed = crypto.getRandomValues(new Uint8Array(32));
        localStorage.setItem(BURNER_KEY, JSON.stringify([...seed]));
      }
      const keypair = await createKeyPairSignerFromPrivateKeyBytes(seed);
      return {
        name: 'Local test wallet',
        address: keypair.address,
        keypair,
        async signTransaction() {
          throw new Error('The burner signs through its keypair.');
        },
        async disconnect() {},
      };
    },
  };
}

export function listWallets(cfg: ChainConfig | null): WalletChoice[] {
  const found = getWallets().get().filter((w) => supports(w, cfg)).map((w) => fromStandard(w, cfg));
  const b = burner(cfg);
  return b ? [...found, b] : found;
}

/** Re-list when wallets register after page load. */
export function onWalletsChanged(cb: () => void): () => void {
  const api = getWallets();
  const offRegister = api.on('register', cb);
  const offUnregister = api.on('unregister', cb);
  return () => {
    offRegister();
    offUnregister();
  };
}
