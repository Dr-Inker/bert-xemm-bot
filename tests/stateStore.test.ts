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

  it('round-trips executable observer economics', () => {
    store.insertObserverSample({
      t: '2026-07-26T00:00:00Z', sizeBert: '5000', raydiumMidUsd: '0.0097',
      krakenBid: '0.0095', krakenAsk: '0.0101', dexSellPriceUsd: '0.00965',
      dexBuyPriceUsd: '0.00971', makerFeeBps: 23, buyMakerEdgeBps: '120',
      sellMakerEdgeBps: '350', dexSellImpactBps: '4', dexBuyImpactBps: '5',
      bookAgeMs: 500, oracleTrusted: true,
    });
    const rows = store.recentObserverSamples(1);
    expect(rows[0]?.sizeBert).toBe('5000');
    expect(rows[0]?.oracleTrusted).toBe(true);
    expect(rows[0]?.makerFeeBps).toBe(23);
  });

  it('persists paper orders and friction-attributed fills', () => {
    const t = '2026-07-26T00:00:00Z';
    store.upsertPaperOrder({ paperOrderId:'po1', side:'buy', price:'0.01', sizeBert:'1000', queueAheadBert:'500', expectedEdgeBps:'50', placedAt:t, updatedAt:t });
    store.cancelPaperOrder('po1', t, 'filled');
    store.insertPaperFill({ paperFillId:'pf1', paperOrderId:'po1', krakenTradeId:1, side:'buy', fillPriceUsd:'0.01', volumeBert:'1000', dexHedgePriceUsd:'0.0102', grossPnlUsd:'0.2', makerFeeUsd:'0.023', transactionCostUsd:'0.02', latencyCostUsd:'0.0204', failureReserveUsd:'0.0102', netPnlUsd:'0.1264', dexImpactBps:'5', t });
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    expect((db.prepare('SELECT status FROM paper_orders WHERE paper_order_id=?').get('po1') as {status:string}).status).toBe('filled');
    expect((db.prepare('SELECT net_pnl_usd FROM paper_fills WHERE paper_fill_id=?').get('pf1') as {net_pnl_usd:string}).net_pnl_usd).toBe('0.1264');
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

  it('sumInFlightHedgesBert sums non-terminal hedges', () => {
    store.insertHedgeRow({ hedgeId:'h1', triggeringFillId:'f1', status:'tx_submitted', jupiterQuote:null, txSig:'s1', slippageRealized:null, bertNotional:'1000', tIntent:'2026-05-21T00:00:00Z', tConfirmed:null });
    store.insertHedgeRow({ hedgeId:'h2', triggeringFillId:'f2', status:'swap_quoted',  jupiterQuote:null, txSig:null, slippageRealized:null, bertNotional:'500',  tIntent:'2026-05-21T00:00:00Z', tConfirmed:null });
    store.insertHedgeRow({ hedgeId:'h3', triggeringFillId:'f3', status:'confirmed',    jupiterQuote:null, txSig:'s3', slippageRealized:'10', bertNotional:'200',  tIntent:'2026-05-21T00:00:00Z', tConfirmed:'2026-05-21T00:01:00Z' });
    store.insertHedgeRow({ hedgeId:'h4', triggeringFillId:'f4', status:'slippage_aborted', jupiterQuote:null, txSig:null, slippageRealized:'200', bertNotional:'750', tIntent:'2026-05-21T00:00:00Z', tConfirmed:null });
    const total = store.sumInFlightHedgesBert();
    expect(total.toString()).toBe('1500');
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
