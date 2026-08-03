import { describe, expect, it, vi } from 'vitest';
import Decimal from 'decimal.js';
import {
  CandidateFillEngine,
  calculateAllInEdge,
  type CandidateFillEngineOpts,
  type CandidateFriction,
} from '../src/candidateFillEngine.js';
import type { CandidateEconomicSnapshot } from '../src/candidateQuoteSampler.js';

const normal: CandidateFriction = {
  makerFeeBps: 23,
  latencyPenaltyBps: 20,
  failedHedgeReserveBps: 10,
  transactionCostUsd: 0.02,
};
const stress: CandidateFriction = {
  makerFeeBps: 25,
  latencyPenaltyBps: 40,
  failedHedgeReserveBps: 20,
  transactionCostUsd: 0.04,
};

function harness(overrides: Partial<CandidateFillEngineOpts> = {}) {
  const store = {
    upsertCandidateOrder: vi.fn(),
    closeCandidateOrder: vi.fn(),
    upsertCandidateFill: vi.fn(),
    abandonCandidateHedgeBatch: vi.fn(),
    syncCandidateGatePeriods: vi.fn(),
  };
  const opts: CandidateFillEngineOpts = {
    strategyFingerprint: 'test-fingerprint',
    ladder: [{ sizeBert: 100, distanceBps: 175 }, { sizeBert: 100, distanceBps: 400 }],
    minAllInEdgeBps: 75,
    repriceThresholdBps: 10,
    maxQuoteAgeMs: 3000,
    crossVenueMaxBps: 150,
    routeVsReserveMaxBps: 75,
    maxBookAgeSec: 15,
    drift5sBps: 35,
    drift30sBps: 75,
    driftResumeStableSec: 30,
    maxPendingHedgeAgeMs: 120_000,
    maxActivePerSideBert: 200,
    normalFriction: normal,
    stressFriction: stress,
    store,
    hedgeBatch: vi.fn().mockResolvedValue({ dexPriceUsd: new Decimal('0.1'), dexImpactBps: new Decimal(2) }),
    ...overrides,
  };
  return { engine: new CandidateFillEngine(opts), store, opts };
}

function snapshot(at: string, sell = '0.1', buy = '0.1'): CandidateEconomicSnapshot {
  const t = new Date(at);
  const sizes = ['100', '500', '1000'];
  return {
    asOf: t,
    raydiumMidUsd: new Decimal('0.1'),
    solUsd: new Decimal(100),
    krakenBid: new Decimal('0.099'),
    krakenAsk: new Decimal('0.101'),
    crossVenueDivergenceBps: new Decimal(0),
    book: {
      pair: 'BERT/USD',
      bids: [{ price: new Decimal('0.08'), volume: new Decimal(0) }],
      asks: [{ price: new Decimal('0.12'), volume: new Decimal(0) }],
      t,
    },
    references: new Map(sizes.map(size => [size, {
      sizeBert: new Decimal(size),
      executableSellPriceUsd: new Decimal(sell),
      executableBuyPriceUsd: new Decimal(buy),
      sellImpactBps: new Decimal(2),
      buyImpactBps: new Decimal(3),
      sellRouteDeviationBps: new Decimal(sell).div('0.1').minus(1).abs().mul(10_000),
      buyRouteDeviationBps: new Decimal(buy).div('0.1').minus(1).abs().mul(10_000),
    }])),
  };
}

describe('CandidateFillEngine', () => {
  it('allocates each public trade once across price-priority rungs and preserves partial remainder', async () => {
    const { engine, store } = harness();
    const t = new Date('2026-08-03T00:00:00.000Z');
    engine.updateQuotes(snapshot(t.toISOString()), t);
    await engine.onTradeBatch([{
      tradeId: 11,
      side: 'sell',
      price: new Decimal('0.09'),
      volume: new Decimal(150),
      t: new Date(t.getTime() + 100),
    }], t);

    const finalFills = store.upsertCandidateFill.mock.calls
      .map(call => call[0])
      .filter(fill => fill.hedgeStatus === 'simulated');
    expect(finalFills.map(fill => fill.volumeBert)).toEqual(['100', '50']);
    expect(finalFills.reduce((sum, fill) => sum + Number(fill.volumeBert), 0)).toBe(150);
    expect(finalFills[1]?.orderRemainingBert).toBe('50');
    expect(store.closeCandidateOrder).toHaveBeenCalledWith(expect.any(String), '50', expect.any(String), 'cancel_on_fill');
  });

  it('uses economic snapshot age for TTL while preserving queue priority at an unchanged price', () => {
    const { engine, store } = harness({ ladder: [{ sizeBert: 100, distanceBps: 400 }], maxActivePerSideBert: 100 });
    const first = snapshot('2026-08-03T00:00:00.000Z');
    engine.updateQuotes(first, first.asOf);
    const ids = engine.activeOrders().map(order => order.candidateOrderId);

    const refreshed = snapshot('2026-08-03T00:00:02.000Z');
    engine.updateQuotes(refreshed, refreshed.asOf);
    expect(engine.activeOrders().map(order => order.candidateOrderId)).toEqual(ids);
    expect(store.closeCandidateOrder).not.toHaveBeenCalled();

    engine.updateQuotes(refreshed, new Date('2026-08-03T00:00:05.001Z'));
    expect(engine.activeOrders()).toHaveLength(0);
    expect(store.closeCandidateOrder).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), 'ttl_stale');
  });

  it('pulls quotes and persists an external provider-rate-limit gate until cleared', () => {
    const { engine, store } = harness({ ladder: [{ sizeBert: 100, distanceBps: 400 }], maxActivePerSideBert: 100 });
    const first = snapshot('2026-08-03T00:00:00.000Z');
    engine.updateQuotes(first, first.asOf);
    expect(engine.activeOrders()).toHaveLength(2);

    engine.setExternalGates([{
      gate: 'provider_rate_limited',
      detailJson: '{"consecutive429s":1}',
    }]);
    engine.updateQuotes(first, new Date('2026-08-03T00:00:00.100Z'));
    expect(engine.activeOrders()).toHaveLength(0);
    expect(store.closeCandidateOrder.mock.calls.slice(-2).every(call => call[3] === 'provider_rate_limited')).toBe(true);
    expect(store.syncCandidateGatePeriods.mock.calls.at(-1)?.[0]).toContainEqual({
      gate: 'provider_rate_limited', detailJson: '{"consecutive429s":1}',
    });

    engine.setExternalGates([]);
    const fresh = snapshot('2026-08-03T00:00:01.000Z');
    engine.updateQuotes(fresh, fresh.asOf);
    expect(engine.activeOrders()).toHaveLength(2);
  });

  it('resumes after drift metrics stay below both thresholds for 30s despite normal adverse ticks', () => {
    const { engine, store } = harness({ ladder: [{ sizeBert: 100, distanceBps: 400 }], maxActivePerSideBert: 100 });
    const initial = snapshot('2026-08-03T00:00:00.000Z');
    engine.updateQuotes(initial, initial.asOf);

    const moved = snapshot('2026-08-03T00:00:05.000Z', '0.0996', '0.1');
    engine.updateQuotes(moved, moved.asOf);
    expect(engine.activeOrders().map(order => order.side)).toEqual(['sell']);
    expect(store.closeCandidateOrder).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), 'drift_pull');

    const metricStable = snapshot('2026-08-03T00:00:10.001Z', '0.0996', '0.1');
    engine.updateQuotes(metricStable, metricStable.asOf);
    expect(engine.activeOrders().map(order => order.side)).toEqual(['sell']);
    for (const [seconds, sell] of [[15, '0.09959'], [20, '0.09961'], [25, '0.09958'], [30, '0.0996'], [35, '0.09957'], [39, '0.09959']] as const) {
      const noisy = snapshot(`2026-08-03T00:00:${String(seconds).padStart(2, '0')}.001Z`, sell, '0.1');
      engine.updateQuotes(noisy, noisy.asOf);
      expect(engine.activeOrders().map(order => order.side)).toEqual(['sell']);
    }
    const stable30 = snapshot('2026-08-03T00:00:40.001Z', '0.09958', '0.1');
    engine.updateQuotes(stable30, stable30.asOf);
    expect(engine.activeOrders().map(order => order.side).sort()).toEqual(['buy', 'sell']);
  });

  it('re-estimates queue ahead from the current book when a price change loses priority', async () => {
    const { engine, store } = harness({ ladder: [{ sizeBert: 100, distanceBps: 400 }], maxActivePerSideBert: 100 });
    const t = new Date('2026-08-03T00:00:00.000Z');
    const initial = snapshot(t.toISOString());
    initial.book.bids = [{ price: new Decimal('0.099'), volume: new Decimal(100) }];
    engine.updateQuotes(initial, t);
    const oldBuy = engine.activeOrders().find(order => order.side === 'buy')!;
    expect(oldBuy.queueAheadRemainingBert).toBe('100');

    await engine.onTradeBatch([{
      tradeId: 21, side: 'sell', price: new Decimal('0.09'), volume: new Decimal(100), t,
    }], t);
    expect(engine.activeOrders().find(order => order.side === 'buy')?.queueAheadRemainingBert).toBe('0');

    const repriced = snapshot('2026-08-03T00:00:01.000Z', '0.1002', '0.1');
    repriced.book.bids = [{ price: new Decimal('0.099'), volume: new Decimal(250) }];
    engine.updateQuotes(repriced, repriced.asOf);
    const newBuy = engine.activeOrders().find(order => order.side === 'buy')!;
    expect(newBuy.candidateOrderId).not.toBe(oldBuy.candidateOrderId);
    expect(newBuy.queueAheadAtPlacementBert).toBe('250');
    expect(newBuy.queueAheadRemainingBert).toBe('250');
    expect(store.closeCandidateOrder).toHaveBeenCalledWith(oldBuy.candidateOrderId, '100', expect.any(String), 'reprice');
  });

  it('cancels every candidate order synchronously on the first partial fill', () => {
    const hedgePending = new Promise<never>(() => undefined);
    const { engine, store } = harness({ hedgeBatch: vi.fn(() => hedgePending) });
    const t = new Date('2026-08-03T00:00:00.000Z');
    engine.updateQuotes(snapshot(t.toISOString()), t);
    void engine.onTradeBatch([{
      tradeId: 12,
      side: 'sell',
      price: new Decimal('0.09'),
      volume: new Decimal(10),
      t: new Date(t.getTime() + 100),
    }], t);

    expect(engine.activeOrders()).toHaveLength(0);
    expect(engine.hasPendingHedge()).toBe(true);
    expect(store.closeCandidateOrder).toHaveBeenCalledTimes(4);
    expect(store.closeCandidateOrder.mock.calls.every(call => call[3] === 'cancel_on_fill')).toBe(true);
  });

  it('computes the 75 bps gate independently under normal and stress friction', () => {
    const reference = new Decimal('0.01');
    const bid = reference.div(new Decimal(1).plus(new Decimal(175).div(10_000)));
    const normalEdge = calculateAllInEdge('buy', bid, reference, new Decimal(500), normal, 75);
    const stressEdge = calculateAllInEdge('buy', bid, reference, new Decimal(500), stress, 75);

    expect(normalEdge.netEdgeBps.toNumber()).toBeGreaterThan(75);
    expect(normalEdge.passes).toBe(true);
    expect(stressEdge.netEdgeBps.toNumber()).toBeLessThan(75);
    expect(stressEdge.passes).toBe(false);
  });

  it('abandons stale restart fills without fabricating current-price economics', () => {
    const { engine, store, opts } = harness();
    const now = new Date('2026-08-03T00:03:00.001Z');
    engine.restorePendingFills([{
      candidateFillId: 'cf-old', candidateOrderId: 'co-old', krakenTradeId: 31,
      strategyFingerprint: 'test-fingerprint',
      hedgeBatchId: 'ch-old', side: 'buy', distanceBps: '400', fillPriceUsd: '0.096',
      volumeBert: '50', orderRemainingBert: '50', referencePriceUsd: '0.1',
      referenceImpactBps: '2', t: '2026-08-03T00:00:00.000Z',
    }], now);

    expect(engine.hasPendingHedge()).toBe(false);
    expect(opts.hedgeBatch).not.toHaveBeenCalled();
    expect(store.abandonCandidateHedgeBatch).toHaveBeenCalledWith('ch-old', now.toISOString(), 'restart_pending_expired');
  });

  it('labels a timely restart hedge distinctly and expires a permanently failing live hedge', async () => {
    const recovered = harness();
    const recoveryNow = new Date('2026-08-03T00:01:00.000Z');
    recovered.engine.restorePendingFills([{
      candidateFillId: 'cf-recent', candidateOrderId: 'co-recent', krakenTradeId: 32,
      strategyFingerprint: 'test-fingerprint',
      hedgeBatchId: 'ch-recent', side: 'buy', distanceBps: '400', fillPriceUsd: '0.096',
      volumeBert: '50', orderRemainingBert: '50', referencePriceUsd: '0.1',
      referenceImpactBps: '2', t: '2026-08-03T00:00:30.000Z',
    }], recoveryNow);
    await recovered.engine.retryPendingHedges(recoveryNow);
    expect(recovered.store.upsertCandidateFill.mock.calls.at(-1)?.[0]).toMatchObject({
      hedgeStatus: 'simulated', economicsSource: 'restart_recovered_executable',
    });

    const failing = harness({ hedgeBatch: vi.fn().mockRejectedValue(new Error('unavailable')) });
    const t = new Date('2026-08-03T01:00:00.000Z');
    failing.engine.updateQuotes(snapshot(t.toISOString()), t);
    await failing.engine.onTradeBatch([{
      tradeId: 33, side: 'sell', price: new Decimal('0.09'), volume: new Decimal(10), t,
    }], t);
    expect(failing.engine.hasPendingHedge()).toBe(true);
    const expired = new Date(t.getTime() + 120_001);
    await failing.engine.retryPendingHedges(expired);
    expect(failing.engine.hasPendingHedge()).toBe(false);
    expect(failing.store.abandonCandidateHedgeBatch).toHaveBeenCalledWith(expect.any(String), expired.toISOString(), 'pending_hedge_expired');
  });
});
