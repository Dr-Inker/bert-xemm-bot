import Decimal from 'decimal.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { spawnKrakenStream, ndjsonLines } from './krakenStream.js';
import { toWsPair } from './krakenPair.js';
import type { HedgeVenue, PlaceLimitParams, AmendParams } from './hedgeVenue.js';
import type { Fill, Order, OrderUpdate, BookSnapshot, FeeTier } from '../types.js';

export interface KrakenObserverConfig {
  cliBinaryPath: string;
  pair: string;
}

/**
 * Observer-mode CEX adapter. Uses public Kraken WS book (no API keys).
 * Balances/open-orders are stubbed; mutations are no-ops.
 */
export class KrakenObserver implements HedgeVenue {
  constructor(private cfg: KrakenObserverConfig) {}

  async *watchBook(pair: string, depth: number): AsyncIterable<BookSnapshot> {
    const wsPair = toWsPair(pair);
    const child = spawnKrakenStream(this.cfg.cliBinaryPath, ['ws', 'book', wsPair, '--depth', String(depth)]);
    try {
      for await (const event of ndjsonLines(child)) {
        const ev = event as { channel?: string; data?: { symbol?: string; bids?: { price: number; qty: number }[]; asks?: { price: number; qty: number }[]; timestamp?: string }[] };
        if (ev?.channel !== 'book' || !ev.data?.[0]) continue;
        const d = ev.data[0];
        if (!d.bids || !d.asks || !d.symbol || !d.timestamp) continue;
        yield {
          pair: d.symbol,
          bids: d.bids.map(l => ({ price: new Decimal(l.price), volume: new Decimal(l.qty) })),
          asks: d.asks.map(l => ({ price: new Decimal(l.price), volume: new Decimal(l.qty) })),
          t: new Date(d.timestamp),
        };
      }
    } finally { child.kill(); }
  }

  async *watchExecutions(): AsyncIterable<Fill> {
    // Observer never places orders — block until shutdown.
    await new Promise<void>(() => {});
  }

  async *watchOrders(): AsyncIterable<OrderUpdate> {
    await new Promise<void>(() => {});
  }

  async balances(): Promise<{ base: Decimal; quote: Decimal }> {
    return { base: new Decimal(0), quote: new Decimal(0) };
  }

  async openOrders(): Promise<Order[]> {
    return [];
  }

  async feeTier(): Promise<FeeTier> {
    return { makerBps: 16, takerBps: 26 };
  }

  async placeLimit(_p: PlaceLimitParams): Promise<string> {
    return 'OBSERVER-NO-OP';
  }

  async cancel(_venueOrderId: string): Promise<void> {}
  async cancelAll(): Promise<{ cancelled: number }> { return { cancelled: 0 }; }
  async cancelAfter(_seconds: number): Promise<void> {}
  async amend(_p: AmendParams): Promise<void> {}
}
