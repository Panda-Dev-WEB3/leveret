// Squared (lvrt_power) and Tickets (lvrt_tickets) products listed on test
// clusters, keyed by the dashboard's symbols. Both read the underlying's
// oracle feed; the bootstrap script creates exactly these.

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

export const powerBySymbol = new Map(POWER_MARKETS.map((p) => [p.symbol, p]));
export const ticketBySymbol = new Map(TICKET_MARKETS.map((t) => [t.symbol, t]));
