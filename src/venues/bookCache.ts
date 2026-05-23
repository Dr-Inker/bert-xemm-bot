import type { BookSnapshot, BookLevel } from '../types.js';
import type { HedgeVenue } from './hedgeVenue.js';
import type { Logger } from '../logger.js';

/**
 * BookCache subscribes to `cex.watchBook(pair, depth)` and keeps the latest
 * BookSnapshot in memory so synchronous consumers (the QuoterLoop's readInputs
 * lambda) can read real top-of-book bid/ask without awaiting a stream.
 *
 * Closes audit gap #10: previously `basis_samples` recorded `kraken_bid=0,
 * kraken_ask=0` because `main.ts` passed an empty book to the quoter.
 *
 * The Kraken WS book stream emits per-side deltas where the opposite side is
 * `[]`. Bids and asks are tracked separately so a bid-only delta does not zero
 * out the asks (and vice versa).
 *
 * Lifecycle: call `run(cex, pair, depth)` once at startup (do not await — it
 * runs for the lifetime of the process). On any stream error or generator
 * exhaustion the loop sleeps 5s and reconnects. Call `shutdown()` to stop.
 */
export class BookCache {
  private pair: string;
  private latestBids: BookLevel[] = [];
  private latestAsks: BookLevel[] = [];
  private latestT: Date = new Date(0);
  private stop = false;
  constructor(pair: string, private logger: Logger) {
    this.pair = pair;
  }

  async run(cex: HedgeVenue, pair: string, depth: number): Promise<void> {
    while (!this.stop) {
      try {
        for await (const snap of cex.watchBook(pair, depth)) {
          if (this.stop) break;
          if (snap.bids.length > 0) this.latestBids = snap.bids;
          if (snap.asks.length > 0) this.latestAsks = snap.asks;
          this.latestT = snap.t;
        }
      } catch (err) {
        this.logger.warn({ err }, 'bookCache stream errored; reconnecting in 5s');
      }
      if (this.stop) break;
      await new Promise(r => setTimeout(r, 5_000));
    }
  }

  snapshot(): BookSnapshot {
    return { pair: this.pair, bids: this.latestBids, asks: this.latestAsks, t: this.latestT };
  }
  shutdown(): void { this.stop = true; }
}
