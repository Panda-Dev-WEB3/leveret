// Which cluster the dashboard talks to. All values are public (inlined into the
// static bundle at build time); leave NEXT_PUBLIC_CLUSTER unset for the
// offline reference dashboard.
import type { Address } from '@solana/kit';

export type ChainCluster = 'localnet' | 'devnet' | 'mainnet';

const cluster = process.env.NEXT_PUBLIC_CLUSTER as ChainCluster | undefined;

const DEFAULT_RPC: Record<ChainCluster, string> = {
  localnet: 'http://127.0.0.1:8899',
  devnet: 'https://api.devnet.solana.com',
  mainnet: 'https://api.mainnet-beta.solana.com',
};

/** USDC mint the programs were built against (`--features devnet` on test clusters). */
const USDC: Record<ChainCluster, Address> = {
  localnet: 'H3tRv17bsBR3ccV5cT9nzt66uqm1wn66tT9rmAiAvrfi' as Address,
  devnet: 'H3tRv17bsBR3ccV5cT9nzt66uqm1wn66tT9rmAiAvrfi' as Address,
  mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address,
};

export const chainConfig = cluster
  ? {
      cluster,
      rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || DEFAULT_RPC[cluster],
      /** Signed-quote API (the oracle pusher; `web/dev/oracle.ts` on test clusters). */
      quoteApi: (process.env.NEXT_PUBLIC_QUOTE_API || 'http://127.0.0.1:8787').replace(/\/$/, ''),
      usdcMint: USDC[cluster],
      /** Wallet Standard chain id. */
      chain: `solana:${cluster}` as const,
      testCluster: cluster !== 'mainnet',
    }
  : null;

export type ChainConfig = NonNullable<typeof chainConfig>;
