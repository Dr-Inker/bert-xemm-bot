import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { BookCache } from '../../src/venues/bookCache.js';

async function* fakeStream(snaps: { bids: { price: string; volume: string }[]; asks: { price: string; volume: string }[]; t: Date }[]) {
  for (const s of snaps) {
    yield {
      pair: 'BERTUSD',
      bids: s.bids.map(l => ({ price: new Decimal(l.price), volume: new Decimal(l.volume) })),
      asks: s.asks.map(l => ({ price: new Decimal(l.price), volume: new Decimal(l.volume) })),
      t: s.t,
    };
  }
}

describe('BookCache', () => {
  it('updates current snapshot as stream yields', async () => {
    const snaps = [
      { bids: [{ price: '0.0176', volume: '1000' }], asks: [{ price: '0.0178', volume: '500' }], t: new Date('2026-05-21T00:00:00Z') },
      { bids: [{ price: '0.0177', volume: '1500' }], asks: [{ price: '0.0179', volume: '800' }], t: new Date('2026-05-21T00:00:02Z') },
    ];
    const cex = { watchBook: vi.fn().mockImplementation(() => fakeStream(snaps)) };
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const cache = new BookCache('BERTUSD', logger as never);

    vi.useFakeTimers();
    const runP = cache.run(cex as never, 'BERTUSD', 10);

    // Drain the finite generator.
    await vi.advanceTimersByTimeAsync(0);

    const s = cache.snapshot();
    expect(s.bids[0]?.price.toString()).toBe('0.0177');
    expect(s.asks[0]?.price.toString()).toBe('0.0179');
    expect(s.pair).toBe('BERTUSD');

    cache.shutdown();
    // Step past the 5s reconnect sleep so run() exits cleanly.
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    await runP;
  }, 10_000);

  it('starts with empty book before any stream data', () => {
    const cache = new BookCache('BERTUSD', { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never);
    const s = cache.snapshot();
    expect(s.pair).toBe('BERTUSD');
    expect(s.bids).toHaveLength(0);
    expect(s.asks).toHaveLength(0);
  });

  it('reconnects after stream error and logs a warning', async () => {
    let calls = 0;
    const erroringStream = (async function* () {
      throw new Error('boom');
      // eslint-disable-next-line no-unreachable
      yield undefined as never;
    })();
    const finalSnap = {
      bids: [{ price: '0.0180', volume: '2000' }],
      asks: [{ price: '0.0181', volume: '900' }],
      t: new Date('2026-05-21T00:00:04Z'),
    };
    const cex = {
      watchBook: vi.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) return erroringStream;
        return fakeStream([finalSnap]);
      }),
    };
    const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
    const cache = new BookCache('BERTUSD', logger as never);

    // Use fake timers so the 5s reconnect sleep doesn't slow the test.
    vi.useFakeTimers();
    const runP = cache.run(cex as never, 'BERTUSD', 10);

    // Let the throwing generator run.
    await vi.advanceTimersByTimeAsync(0);
    // Advance past the 5s reconnect sleep.
    await vi.advanceTimersByTimeAsync(5_000);
    // Let the second generator yield.
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.warn).toHaveBeenCalled();
    expect(cache.snapshot().bids[0]?.price.toString()).toBe('0.018');
    expect(cache.snapshot().asks[0]?.price.toString()).toBe('0.0181');

    cache.shutdown();
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();
    await Promise.race([runP, new Promise(r => setTimeout(r, 100))]);
  }, 10_000);
});
