import { describe, it, expect, vi } from 'vitest';
import { StateStore } from '../../src/stateStore.js';
import { sweepStaleHedges, STALE_HEDGE_MAX_AGE_MS } from '../../src/risk/hedgeSweeper.js';

const row = (hedgeId: string, status: string, tIntent: string, bertNotional: string) => ({
  hedgeId, triggeringFillId: `f-${hedgeId}`, status,
  jupiterQuote: null, txSig: null, slippageRealized: null,
  bertNotional, tIntent, tConfirmed: null,
});

describe('sweepStaleHedges', () => {
  it('dead-letters a stale non-terminal row and removes it from the in-flight sum', () => {
    const store = new StateStore(':memory:');
    const now = new Date('2026-05-21T01:00:00Z');
    store.insertHedgeRow(row('old', 'intent_queued', '2026-05-21T00:00:00Z', '-1000'));
    expect(store.sumInFlightHedgesBert().toString()).toBe('-1000');

    const notifier = { page: vi.fn() };
    const swept = sweepStaleHedges({ store, notifier, now });

    expect(swept).toBe(1);
    expect(store.sumInFlightHedgesBert().toString()).toBe('0');
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('old'));
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('-1000'));
  });

  it('leaves a fresh in-flight row alone', () => {
    const store = new StateStore(':memory:');
    const now = new Date('2026-05-21T00:01:00Z');
    store.insertHedgeRow(row('fresh', 'tx_submitted', '2026-05-21T00:00:30Z', '-1000'));

    const notifier = { page: vi.fn() };
    const swept = sweepStaleHedges({ store, notifier, now });

    expect(swept).toBe(0);
    expect(store.sumInFlightHedgesBert().toString()).toBe('-1000');
    expect(notifier.page).not.toHaveBeenCalled();
  });

  it('leaves terminal rows alone', () => {
    const store = new StateStore(':memory:');
    const now = new Date('2026-05-21T01:00:00Z');
    store.insertHedgeRow(row('done', 'confirmed', '2026-05-21T00:00:00Z', '-1000'));

    const notifier = { page: vi.fn() };
    expect(sweepStaleHedges({ store, notifier, now })).toBe(0);
    expect(notifier.page).not.toHaveBeenCalled();
  });

  it('is fail-safe: a throwing store does not propagate', () => {
    const store = {
      listStaleInFlightHedges: vi.fn(() => { throw new Error('sqlite disk I/O error'); }),
      markHedgeFailed: vi.fn(),
    };
    const notifier = { page: vi.fn() };
    expect(() => sweepStaleHedges({ store: store as never, notifier })).not.toThrow();
    expect(sweepStaleHedges({ store: store as never, notifier })).toBe(0);
  });

  it('is fail-safe per row: one bad row does not stop the rest', () => {
    const store = {
      listStaleInFlightHedges: vi.fn(() => [
        { hedgeId: 'bad', bertNotional: '-1', tIntent: 'x', status: 'intent_queued' },
        { hedgeId: 'good', bertNotional: '-2', tIntent: 'x', status: 'intent_queued' },
      ]),
      markHedgeFailed: vi.fn((id: string) => { if (id === 'bad') throw new Error('locked'); }),
    };
    const notifier = { page: vi.fn() };
    expect(sweepStaleHedges({ store: store as never, notifier })).toBe(1);
    expect(store.markHedgeFailed).toHaveBeenCalledTimes(2);
  });

  it('exposes a sane default age bound', () => {
    expect(STALE_HEDGE_MAX_AGE_MS).toBeGreaterThanOrEqual(60_000);
  });
});
