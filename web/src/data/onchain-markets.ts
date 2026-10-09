// Markets listed on-chain, keyed by the dashboard's symbols. Market ids are the
// oracle feed / engine market ids; the bootstrap script creates exactly these.
import type { BucketName } from '../lib/chain/pdas.ts';

export type OnchainFamily = 'Core' | 'Stocks' | 'Factors';

export interface OnchainMarket {
  symbol: string;
  id: number;
  family: OnchainFamily;
  bucket: BucketName;
}

export const ONCHAIN_MARKETS: OnchainMarket[] = [
  { symbol: 'SOL', id: 1, family: 'Core', bucket: 'Core' },
  { symbol: 'BTC', id: 2, family: 'Core', bucket: 'Core' },
  { symbol: 'ETH', id: 3, family: 'Core', bucket: 'Core' },
  { symbol: 'HYPE', id: 4, family: 'Core', bucket: 'Core' },
  { symbol: 'NVDA', id: 10, family: 'Stocks', bucket: 'Stocks' },
  { symbol: 'TSLA', id: 11, family: 'Stocks', bucket: 'Stocks' },
  { symbol: 'SPY', id: 12, family: 'Stocks', bucket: 'Stocks' },
  { symbol: 'QQQ', id: 13, family: 'Stocks', bucket: 'Stocks' },
  { symbol: 'COIN', id: 14, family: 'Stocks', bucket: 'Stocks' },
  { symbol: 'TRND', id: 20, family: 'Factors', bucket: 'Factors' },
  { symbol: 'STDY', id: 21, family: 'Factors', bucket: 'Factors' },
  { symbol: 'AIB', id: 22, family: 'Factors', bucket: 'Factors' },
  { symbol: 'QLTY', id: 23, family: 'Factors', bucket: 'Factors' },
];

/** $LVRT feed behind the staked-tranche TWAP. */
export const LVRT_MARKET_ID = 99;

/** Engine shards per market (bootstrap creates them all). */
export const SHARDS = 8;
export const CUSTODY_COUNT = 2;

export const onchainBySymbol = new Map(ONCHAIN_MARKETS.map((m) => [m.symbol, m]));
