import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { PaperFillEngine } from '../src/paperFillEngine.js';

describe('PaperFillEngine', () => {
  it('requires public traded volume to consume queue ahead before filling', async () => {
    const store = { upsertPaperOrder: vi.fn(), cancelPaperOrder: vi.fn(), insertPaperFill: vi.fn() };
    const engine = new PaperFillEngine({
      minNetEdgeBps: 40, driftThresholdBps: 5, latencyPenaltyBps: 20,
      failedHedgeReserveBps: 10, transactionCostUsd: 0.02, store,
      hedgeAtFill: vi.fn().mockResolvedValue({ dexPriceUsd: new Decimal('0.0102'), makerFeeUsd: new Decimal('0.023'), dexImpactBps: new Decimal(5) }),
    });
    const book = { pair: 'BERTUSD', bids: [{ price: new Decimal('0.01'), volume: new Decimal(100) }], asks: [{ price: new Decimal('0.0105'), volume: new Decimal(100) }], t: new Date() };
    engine.updateQuotes([{ sizeBert: new Decimal(1000), side: 'buy', price: new Decimal('0.01'), expectedEdgeBps: new Decimal(50), book, oracleTrusted: true }]);
    await engine.onTrade({ tradeId: 1, side: 'sell', price: new Decimal('0.01'), volume: new Decimal(80), t: new Date() });
    expect(store.insertPaperFill).not.toHaveBeenCalled();
    await engine.onTrade({ tradeId: 2, side: 'sell', price: new Decimal('0.01'), volume: new Decimal(1020), t: new Date() });
    expect(store.insertPaperFill).toHaveBeenCalledOnce();
    const fill = store.insertPaperFill.mock.calls[0]![0] as Record<string, string>;
    expect(fill.volumeBert).toBe('1000');
    expect(Number(fill.netPnlUsd)).toBeCloseTo(0.1264, 6);
  });

  it('cancels quotes when the oracle becomes untrusted', () => {
    const store = { upsertPaperOrder: vi.fn(), cancelPaperOrder: vi.fn(), insertPaperFill: vi.fn() };
    const engine = new PaperFillEngine({ minNetEdgeBps: 40, driftThresholdBps: 5, latencyPenaltyBps: 20, failedHedgeReserveBps: 10, transactionCostUsd: 0.02, store,
      hedgeAtFill: vi.fn() });
    const book = { pair: 'BERTUSD', bids: [{ price: new Decimal('0.01'), volume: new Decimal(100) }], asks: [{ price: new Decimal('0.0105'), volume: new Decimal(100) }], t: new Date() };
    engine.updateQuotes([{ sizeBert: new Decimal(1000), side: 'sell', price: new Decimal('0.0105'), expectedEdgeBps: new Decimal(50), book, oracleTrusted: true }]);
    engine.updateQuotes([]);
    expect(store.cancelPaperOrder).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'untrusted_or_unprofitable');
  });
});
