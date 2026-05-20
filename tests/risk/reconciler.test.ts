import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { Reconciler } from '../../src/risk/reconciler.js';

describe('Reconciler.run', () => {
  it('passes when venue open orders match DB', async () => {
    const cex = { openOrders: vi.fn().mockResolvedValue([{ venueOrderId: 'O1', clOrdId: 'cl-1', side: 'buy', price: new Decimal('0.0177'), volume: new Decimal('1000'), status: 'open', placedAt: new Date() }]) };
    const store = { listOpenOrders: vi.fn().mockResolvedValue([{ venueOrderId: 'O1' }]), setFlag: vi.fn() };
    const r = new Reconciler({ cex: cex as never, store: store as never, notifier: { page: vi.fn() } as never });
    const ok = await r.run();
    expect(ok).toBe(true);
  });

  it('fails closed when DB has orders the venue does not', async () => {
    const cex = { openOrders: vi.fn().mockResolvedValue([]) };
    const store = { listOpenOrders: vi.fn().mockResolvedValue([{ venueOrderId: 'O1' }]), setFlag: vi.fn() };
    const r = new Reconciler({ cex: cex as never, store: store as never, notifier: { page: vi.fn() } as never });
    const ok = await r.run();
    expect(ok).toBe(false);
    expect(store.setFlag).toHaveBeenCalledWith('degraded', '1');
  });
});
