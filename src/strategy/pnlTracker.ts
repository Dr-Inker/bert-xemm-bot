import Decimal from 'decimal.js';
import type { Fill } from '../types.js';

export interface PnlSnapshot {
  realized: Decimal;       // USD
  unrealized: Decimal;     // USD
  totalPct: number;        // (realized + unrealized) / book × 100
  asOf: Date;
}

interface DayStart {
  bertNet: Decimal;
  midUsd: Decimal;
  krakenQuote: Decimal;
  t: Date;
}

export class PnlTracker {
  private fills: Fill[] = [];
  private dayStart: DayStart = {
    bertNet: new Decimal(0),
    midUsd: new Decimal(0),
    krakenQuote: new Decimal(0),
    t: this.dayStartTime(new Date()),
  };

  /** Roll the "day start" reference and clear fills older than 24h. */
  rolloverIfNeeded(now: Date, bertNet: Decimal, midUsd: Decimal, krakenQuote: Decimal): void {
    const todayStart = this.dayStartTime(now);
    if (todayStart.getTime() > this.dayStart.t.getTime()) {
      this.dayStart = { bertNet, midUsd, krakenQuote, t: todayStart };
      // Drop fills older than 24h.
      const cutoff = now.getTime() - 24 * 3600 * 1000;
      this.fills = this.fills.filter(f => f.t.getTime() >= cutoff);
    }
  }

  recordFill(f: Fill): void {
    this.fills.push(f);
  }

  /** USD-denominated realized PnL across all retained (≤24h) fills. */
  realized(): Decimal {
    let total = new Decimal(0);
    for (const f of this.fills) {
      const notional = f.volume.mul(f.price);
      if (f.side === 'sell') total = total.plus(notional).minus(f.fee);
      else total = total.minus(notional).minus(f.fee);
    }
    return total;
  }

  unrealized(bertNet: Decimal, currentMidUsd: Decimal): Decimal {
    // Mark-to-market vs day-start book value of BERT exposure.
    const nowValue = bertNet.mul(currentMidUsd);
    const startValue = this.dayStart.bertNet.mul(this.dayStart.midUsd);
    return nowValue.minus(startValue);
  }

  snapshot(bertNet: Decimal, currentMidUsd: Decimal, now: Date): PnlSnapshot {
    this.rolloverIfNeeded(now, bertNet, currentMidUsd, this.dayStart.krakenQuote);
    const realized = this.realized();
    const unrealized = this.unrealized(bertNet, currentMidUsd);
    const startBookUsd = this.dayStart.bertNet.mul(this.dayStart.midUsd).abs()
      .plus(this.dayStart.krakenQuote.abs());
    const book = startBookUsd.gt(0) ? startBookUsd : new Decimal(500);
    const totalPct = realized.plus(unrealized).div(book).mul(100).toNumber();
    return { realized, unrealized, totalPct, asOf: now };
  }

  /** Bootstrap call: invoked once at startup to set the day-start reference. */
  initDayStart(bertNet: Decimal, midUsd: Decimal, krakenQuote: Decimal, now: Date): void {
    this.dayStart = { bertNet, midUsd, krakenQuote, t: this.dayStartTime(now) };
  }

  private dayStartTime(t: Date): Date {
    const d = new Date(t);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}
