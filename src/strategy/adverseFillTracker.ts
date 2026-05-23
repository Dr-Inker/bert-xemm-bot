import Decimal from 'decimal.js';
import type { Fill, Side } from '../types.js';

interface RecordedFill {
  side: Side;
  price: Decimal;
  t: Date;
  postMidUsd: Decimal | null;   // null until 5min post-fill
}

export interface AdverseFillTrackerOpts {
  windowSize?: number;          // default 20
  postFillDelayMs?: number;     // default 5 * 60_000
  minResolved?: number;         // default 5 — ignore adverse share until this many post-mids resolve
  getMidUsd: () => Promise<Decimal>;
}

export class AdverseFillTracker {
  private fills: RecordedFill[] = [];
  private timers: NodeJS.Timeout[] = [];

  constructor(private opts: AdverseFillTrackerOpts) {}

  recordFill(f: Fill): void {
    const rec: RecordedFill = { side: f.side, price: f.price, t: f.t, postMidUsd: null };
    const windowSize = this.opts.windowSize ?? 20;
    this.fills.push(rec);
    if (this.fills.length > windowSize) this.fills.shift();
    const delay = this.opts.postFillDelayMs ?? 5 * 60_000;
    const timer = setTimeout(async () => {
      try {
        rec.postMidUsd = await this.opts.getMidUsd();
      } catch {
        rec.postMidUsd = null;
      }
    }, delay);
    this.timers.push(timer);
  }

  /** Share of last-N fills with a resolved postMid that moved adversely. Returns 0 if no resolved fills. */
  adverseShareLast20(): number {
    const resolved = this.fills.filter(f => f.postMidUsd !== null);
    if (resolved.length < (this.opts.minResolved ?? 5)) return 0;
    let adverse = 0;
    for (const f of resolved) {
      // BUY adverse: price went DOWN after we bought (we paid too much).
      // SELL adverse: price went UP after we sold (we sold too cheap).
      const post = f.postMidUsd!;
      if (f.side === 'buy' && post.lt(f.price)) adverse++;
      else if (f.side === 'sell' && post.gt(f.price)) adverse++;
    }
    return adverse / resolved.length;
  }

  /** Cancel pending 5min timers (call on shutdown). */
  shutdown(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }
}
