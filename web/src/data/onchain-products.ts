// Squared (lvrt_power), Tickets (lvrt_tickets) and Twins (lvrt_twins)
// products listed on test clusters, keyed by the dashboard's symbols. All read
// the underlying's oracle feed; the bootstrap script creates exactly these.

export interface PowerProduct {
  symbol: string;
  /** lvrt_power market id */
  id: number;
  underlying: string;
  /** oracle feed id of the underlying */
  underlyingId: number;
}

export interface TicketProduct {
  symbol: string;
  /** ticket market id = the underlying's oracle feed id */
  marketId: number;
  underlying: string;
}

export const POWER_MARKETS: PowerProduct[] = [
  { symbol: 'NVDA²', id: 1, underlying: 'NVDA', underlyingId: 10 },
  { symbol: 'SPY²', id: 2, underlying: 'SPY', underlyingId: 12 },
  { symbol: 'SOL²', id: 3, underlying: 'SOL', underlyingId: 1 },
];

export const TICKET_MARKETS: TicketProduct[] = [
  { symbol: 'NVDA-T', marketId: 10, underlying: 'NVDA' },
  { symbol: 'SOL-T', marketId: 1, underlying: 'SOL' },
];

export interface TwinProduct {
  symbol: string;
  /** engine market (= oracle feed id) the twin's 1× long trades on */
  marketId: number;
  underlying: string;
}

/** §10 launch set, plus lSOL on test clusters so Twins can be tried at
 *  weekends (stock opens, and so mints, are refused while the session is
 *  closed; redemptions never are). */
export const TWIN_MARKETS: TwinProduct[] = [
  { symbol: 'lNVDA', marketId: 10, underlying: 'NVDA' },
  { symbol: 'lTSLA', marketId: 11, underlying: 'TSLA' },
  { symbol: 'lSPY', marketId: 12, underlying: 'SPY' },
  { symbol: 'lQQQ', marketId: 13, underlying: 'QQQ' },
  { symbol: 'lCOIN', marketId: 14, underlying: 'COIN' },
  { symbol: 'lSOL', marketId: 1, underlying: 'SOL' },
];

/** On-chain symbol: 8 bytes, zero-padded. */
export const twinSymbolBytes = (symbol: string) => {
  const b = new Uint8Array(8);
  b.set(new TextEncoder().encode(symbol).slice(0, 8));
  return b;
};

export const twinBySymbol = new Map(TWIN_MARKETS.map((t) => [t.symbol, t]));
export const powerBySymbol = new Map(POWER_MARKETS.map((p) => [p.symbol, p]));
export const ticketBySymbol = new Map(TICKET_MARKETS.map((t) => [t.symbol, t]));
