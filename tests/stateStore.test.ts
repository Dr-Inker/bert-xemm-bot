import { describe, it, expect, beforeEach } from 'vitest';
import { StateStore } from '../src/stateStore.js';

describe('StateStore', () => {
  let store: StateStore;
  beforeEach(() => { store = new StateStore(':memory:'); });

  it('round-trips an order', () => {
    store.insertOrder({
      clOrdId: 'cl-1', krakenTxid: 'OABC', side: 'buy',
      price: '0.0177', volume: '1000', status: 'open',
      placedAt: '2026-05-20T00:00:00Z', lastUpdated: '2026-05-20T00:00:00Z',
    });
    const got = store.getOrderByClOrdId('cl-1');
    expect(got?.krakenTxid).toBe('OABC');
    expect(got?.status).toBe('open');
  });

  it('flags singleton enforces single row per key', () => {
    store.setFlag('degraded', '1');
    store.setFlag('degraded', '0');
    expect(store.getFlag('degraded')).toBe('0');
  });

  it('records a basis sample', () => {
    store.insertBasisSample({
      t: '2026-05-20T00:00:00Z', raydiumMidUsd: '0.0177',
      krakenBid: '0.0176', krakenAsk: '0.0178', solUsd: '86.12',
      wouldHaveActed: false,
    });
    const rows = store.recentBasisSamples(10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raydiumMidUsd).toBe('0.0177');
  });

  it('withTransaction rolls back on throw', () => {
    expect(() => store.withTransaction(() => {
      store.insertOrder({
        clOrdId: 'cl-2', krakenTxid: 'OXYZ', side: 'sell',
        price: '0.0178', volume: '1000', status: 'open',
        placedAt: '2026-05-20T00:00:00Z', lastUpdated: '2026-05-20T00:00:00Z',
      });
      throw new Error('boom');
    })).toThrow('boom');
    expect(store.getOrderByClOrdId('cl-2')).toBeNull();
  });

  it('insertKillEvent persists kill rows', () => {
    store.insertKillEvent({ t: '2026-05-21T00:00:00Z', conditionId: 0, snapshotJson: '{"tripped":true}', actionTaken: 'cancel_all_reduce_only' });
    const rows = (store as unknown as { db: import('better-sqlite3').Database }).db
      .prepare('SELECT * FROM kill_events ORDER BY id DESC LIMIT 1').all() as Array<{ t: string; condition_id: number; snapshot_json: string; action_taken: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action_taken).toBe('cancel_all_reduce_only');
  });

  it('listOpenOrders returns only orders with status=open', () => {
    store.insertOrder({
      clOrdId: 'cl-open-1', krakenTxid: 'O1', side: 'buy',
      price: '0.0177', volume: '1000', status: 'open',
      placedAt: '2026-05-20T00:00:00Z', lastUpdated: '2026-05-20T00:00:00Z',
    });
    store.insertOrder({
      clOrdId: 'cl-cancelled-1', krakenTxid: 'O2', side: 'sell',
      price: '0.0178', volume: '1000', status: 'cancelled',
      placedAt: '2026-05-20T00:00:00Z', lastUpdated: '2026-05-20T00:00:00Z',
    });
    store.insertOrder({
      clOrdId: 'cl-open-2', krakenTxid: 'O3', side: 'sell',
      price: '0.0180', volume: '500', status: 'open',
      placedAt: '2026-05-20T00:00:00Z', lastUpdated: '2026-05-20T00:00:00Z',
    });
    const open = store.listOpenOrders();
    expect(open).toHaveLength(2);
    expect(open.map(o => o.venueOrderId).sort()).toEqual(['O1', 'O3']);
    expect(open.find(o => o.venueOrderId === 'O1')?.clOrdId).toBe('cl-open-1');
  });
});
