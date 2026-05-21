import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { PnlTracker } from '../../src/strategy/pnlTracker.js';
import type { Fill, Side } from '../../src/types.js';

function fill(side: Side, price: string, volume: string, fee = '0.01', t = new Date('2026-05-21T00:00:00Z')): Fill {
  return { fillId: 'F', orderClOrdId: 'cl', side, price: new Decimal(price), volume: new Decimal(volume), fee: new Decimal(fee), t };
}

describe('PnlTracker', () => {
  it('realized PnL: buy then sell at higher price is positive', () => {
    const t = new PnlTracker();
    t.initDayStart(new Decimal(0), new Decimal('0.0177'), new Decimal('500'), new Date('2026-05-21T00:00:00Z'));
    t.recordFill(fill('buy',  '0.0177', '1000', '0.1'));
    t.recordFill(fill('sell', '0.0180', '1000', '0.1'));
    // sell side adds: 1000*0.0180 - 0.1 = +17.9
    // buy side adds: -(1000*0.0177) - 0.1 = -17.8
    // total = 0.1
    const r = t.realized();
    expect(parseFloat(r.toFixed(4))).toBeCloseTo(0.1, 3);
  });

  it('unrealized PnL: bertNet revalued at current mid vs day-start mid', () => {
    const t = new PnlTracker();
    t.initDayStart(new Decimal('1000'), new Decimal('0.0177'), new Decimal('0'), new Date('2026-05-21T00:00:00Z'));
    const u = t.unrealized(new Decimal('1000'), new Decimal('0.0180'));
    // 1000 * 0.0180 - 1000 * 0.0177 = 0.3
    expect(parseFloat(u.toFixed(4))).toBeCloseTo(0.3, 3);
  });

  it('snapshot computes totalPct = (realized + unrealized) / startBook x 100', () => {
    const t = new PnlTracker();
    const now = new Date('2026-05-21T12:00:00Z');
    t.initDayStart(new Decimal('1000'), new Decimal('0.0177'), new Decimal('100'), now);
    t.recordFill(fill('sell', '0.0180', '500', '0.05', now));
    // realized: 500*0.0180 - 0.05 = 8.95
    // unrealized: 1000*0.0180 - 1000*0.0177 = 0.3
    // startBook: |1000*0.0177| + |100| = 17.7 + 100 = 117.7
    // totalPct: (8.95 + 0.3) / 117.7 * 100 ~ 7.86
    const s = t.snapshot(new Decimal('1000'), new Decimal('0.0180'), now);
    expect(parseFloat(s.totalPct.toFixed(2))).toBeCloseTo(7.86, 1);
  });

  it('rolls over at UTC midnight: day-start refreshed, old fills dropped', () => {
    const t = new PnlTracker();
    const day1 = new Date('2026-05-21T08:00:00Z');
    t.initDayStart(new Decimal('100'), new Decimal('0.0177'), new Decimal('0'), day1);
    t.recordFill(fill('buy', '0.0177', '50', '0', new Date('2026-05-21T08:30:00Z'))); // -8.85
    // Fast-forward 26h.
    const day2 = new Date('2026-05-22T10:00:00Z');
    t.rolloverIfNeeded(day2, new Decimal('150'), new Decimal('0.0180'), new Decimal('0'));
    // Day rolled; old fills (>24h ago) dropped.
    expect(t.realized().toString()).toBe('0');
  });
});
