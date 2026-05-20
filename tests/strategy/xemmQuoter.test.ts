import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { decideQuotes, type QuoterConfig, type QuoterInput, type QuoteIntent } from '../../src/strategy/xemmQuoter.js';

function baseInput(overrides: Partial<QuoterInput> = {}): QuoterInput {
  return {
    ref: { raydiumMidUsd: new Decimal('0.0177'), solUsd: new Decimal('86.12'), asOf: new Date() },
    oracleTrusted: true,
    krakenBook: { pair: 'BERTUSD', bids: [], asks: [], t: new Date() },
    openOrders: [],
    inventory: { bertNet: new Decimal('0'), usdNet: new Decimal('0'), asOf: new Date() },
    feeTier: { makerBps: 16, takerBps: 26 },
    dexCostBps: 25 + 10,
    config: {
      bufferBps: 80, driftThresholdBps: 15, inventorySkewBpsPerUsd: 0.05,
      minEdgeBps: 50, maxInventoryUsd: 500, defaultVolumeBert: new Decimal('1000'),
    } satisfies QuoterConfig,
    ...overrides,
  };
}

describe('decideQuotes', () => {
  it('emits two PLACE intents (bid+ask) on first tick with no inventory', () => {
    const out = decideQuotes(baseInput());
    expect(out).toHaveLength(2);
    expect(out.find((i: QuoteIntent) => i.action === 'place' && i.side === 'buy')).toBeDefined();
    expect(out.find((i: QuoteIntent) => i.action === 'place' && i.side === 'sell')).toBeDefined();
  });

  it('refuses to quote when oracle is untrusted', () => {
    const out = decideQuotes(baseInput({ oracleTrusted: false }));
    expect(out.every((i: QuoteIntent) => i.action !== 'place')).toBe(true);
  });

  it('skips a side whose profitability gate fails (bufferBps too tight)', () => {
    const out = decideQuotes(baseInput({ config: { ...baseInput().config, bufferBps: 40, minEdgeBps: 50 } }));
    expect(out.filter((i: QuoteIntent) => i.action === 'place')).toHaveLength(0);
  });

  it('skews quotes when inventory is long (widens bid, tightens ask)', () => {
    const out = decideQuotes(baseInput({
      inventory: { bertNet: new Decimal('20000'), usdNet: new Decimal('354'), asOf: new Date() },
    }));
    const bid = out.find((i: QuoteIntent) => i.action === 'place' && i.side === 'buy');
    const ask = out.find((i: QuoteIntent) => i.action === 'place' && i.side === 'sell');
    if (bid && bid.action === 'place' && ask && ask.action === 'place') {
      expect(bid.price.lt('0.01756')).toBe(true);
      expect(ask.price.lt('0.01784')).toBe(true);
    } else {
      throw new Error('expected both place intents');
    }
  });

  it('emits only reducing-side place when |usdNet| > maxInventoryUsd', () => {
    const out = decideQuotes(baseInput({
      inventory: { bertNet: new Decimal('50000'), usdNet: new Decimal('885'), asOf: new Date() },
    }));
    expect(out.find((i: QuoteIntent) => i.action === 'place' && i.side === 'buy')).toBeUndefined();
    expect(out.find((i: QuoteIntent) => i.action === 'place' && i.side === 'sell')).toBeDefined();
  });
});
