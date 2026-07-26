import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { measureObserverEconomics } from '../src/observerEconomics.js';

describe('measureObserverEconomics', () => {
  it('calculates both executable maker edges after fees', async () => {
    const quote = vi.fn()
      .mockResolvedValueOnce({ outAmount: '1000000000', priceImpactPct: '0.001', routePlan: [], otherAmountThreshold: '0', slippageBps: 50, contextSlot: 1, timeTaken: 0 })
      .mockResolvedValueOnce({ outAmount: '1000000000', priceImpactPct: '0.002', routePlan: [], otherAmountThreshold: '0', slippageBps: 50, contextSlot: 1, timeTaken: 0 })
      .mockResolvedValueOnce({ outAmount: '1000000000', priceImpactPct: '0.002', routePlan: [], otherAmountThreshold: '0', slippageBps: 50, contextSlot: 1, timeTaken: 0 });
    const e = await measureObserverEconomics({
      sizeBert: new Decimal(1000), krakenBid: new Decimal('0.095'), krakenAsk: new Decimal('0.105'),
      raydiumMidUsd: new Decimal('0.1'), solUsd: new Decimal(100), makerFeeBps: 23,
      jupiterBaseUrl: 'https://example.test', slippageBps: 50, quote,
    });
    expect(e.dexSellPriceUsd.toString()).toBe('0.1');
    expect(e.dexBuyPriceUsd.toString()).toBe('0.1');
    expect(e.buyMakerEdgeBps.toNumber()).toBeCloseTo(503.3158, 3);
    expect(e.sellMakerEdgeBps.toNumber()).toBeCloseTo(477, 6);
    expect(quote).toHaveBeenCalledTimes(3);
  });
});
