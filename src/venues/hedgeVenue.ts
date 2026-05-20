import Decimal from 'decimal.js';
import type { Order, Fill, OrderUpdate, BookSnapshot, FeeTier, Side } from '../types.js';

export interface PlaceLimitParams {
  side: Side;
  price: Decimal;
  volume: Decimal;
  postOnly: true;
  clOrdId: string;
}

export interface AmendParams {
  venueOrderId: string;
  price?: Decimal;
  volume?: Decimal;
  deadlineSec: number; // [2, 60]
}

export interface HedgeVenue {
  watchExecutions(): AsyncIterable<Fill>;
  watchOrders(): AsyncIterable<OrderUpdate>;
  watchBook(pair: string, depth: number): AsyncIterable<BookSnapshot>;

  placeLimit(p: PlaceLimitParams): Promise<string>;
  amend(p: AmendParams): Promise<void>;
  cancel(venueOrderId: string): Promise<void>;
  cancelAll(): Promise<{ cancelled: number }>;
  cancelAfter(seconds: number): Promise<void>;

  balances(): Promise<{ base: Decimal; quote: Decimal }>;
  openOrders(): Promise<Order[]>;
  feeTier(): Promise<FeeTier>;
}

export class VenueError extends Error {
  constructor(public category: 'auth'|'rate_limit'|'network'|'validation'|'api'|'parse', message: string, public retryable: boolean, public retryAfterMs?: number) {
    super(`[${category}] ${message}`);
  }
}
