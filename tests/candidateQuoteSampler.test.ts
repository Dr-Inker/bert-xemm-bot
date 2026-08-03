import { afterEach, describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import { JupiterQuoteRateLimiter, measureCandidateSnapshot } from '../src/candidateQuoteSampler.js';
import type { QuoteArgs, QuoteResp } from '../src/venues/jupiterApi.js';

const response = (outAmount: string): QuoteResp => ({
  outAmount,
  otherAmountThreshold: '0',
  slippageBps: 50,
  routePlan: [],
  priceImpactPct: '0.001',
  contextSlot: 1,
  timeTaken: 0,
});

afterEach(() => { vi.useRealTimers(); });

describe('candidate quote sampling', () => {
  it('deduplicates ladder sizes and publishes only a complete size-specific two-way snapshot', async () => {
    const quote = vi.fn(async (args: QuoteArgs) => ({ ...response(args.amount), inAmount: args.amount }));
    const t = new Date('2026-08-03T00:00:00.000Z');
    const sampled = await measureCandidateSnapshot({
      sizesBert: [new Decimal(1000), new Decimal(500), new Decimal(500)],
      raydiumMidUsd: new Decimal('0.1'),
      solUsd: new Decimal(100),
      book: {
        pair: 'BERT/USD',
        bids: [{ price: new Decimal('0.099'), volume: new Decimal(10) }],
        asks: [{ price: new Decimal('0.101'), volume: new Decimal(10) }],
        t,
      },
      jupiterBaseUrl: 'https://example.test',
      slippageBps: 50,
      quote,
      now: () => t,
    });

    expect(quote).toHaveBeenCalledTimes(4);
    expect([...sampled.references.keys()]).toEqual(['1000', '500']);
    expect(sampled.references.get('500')?.executableSellPriceUsd.toString()).toBe('0.1');
    expect(sampled.references.get('500')?.executableBuyPriceUsd.toString()).toBe('0.1');
    expect(quote.mock.calls.filter(([args]) => args.swapMode === 'ExactOut')).toHaveLength(2);
  });

  it('serializes Jupiter quote starts at maxRpcCallsPerSec', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const quoteImpl = vi.fn(async (args: QuoteArgs) => {
      starts.push(Date.now());
      return response(args.amount);
    });
    const limiter = new JupiterQuoteRateLimiter(2, quoteImpl);
    const args: QuoteArgs = {
      inputMint: 'in', outputMint: 'out', amount: '1', slippageBps: 50, baseUrl: 'https://example.test',
    };
    const calls = [limiter.quote(args), limiter.quote(args), limiter.quote(args)];
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(calls);

    expect(starts).toEqual([0, 500, 1000]);
  });

  it('starts snapshot TTL before the first constituent quote is constructed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const quote = vi.fn(async (args: QuoteArgs) => {
      vi.setSystemTime(Date.now() + 400);
      return { ...response(args.amount), inAmount: args.amount };
    });
    const sampled = await measureCandidateSnapshot({
      sizesBert: [new Decimal(1000), new Decimal(500)],
      raydiumMidUsd: new Decimal('0.1'), solUsd: new Decimal(100),
      book: {
        pair: 'BERT/USD', bids: [{ price: new Decimal('0.099'), volume: new Decimal(1) }],
        asks: [{ price: new Decimal('0.101'), volume: new Decimal(1) }], t: new Date(0),
      },
      jupiterBaseUrl: 'https://example.test', slippageBps: 50, quote,
      now: () => new Date(Date.now()),
    });

    const completedAtMs = Date.now();
    expect(completedAtMs).toBe(1600);
    expect(sampled.asOf.getTime()).toBe(0);
    expect(3100 - sampled.asOf.getTime()).toBeGreaterThan(3000);
    expect(3100 - completedAtMs).toBeLessThan(3000);
  });
});
