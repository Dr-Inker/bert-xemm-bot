import { describe, it, expect, beforeEach } from 'vitest';
import { StateStore } from '../src/stateStore.js';
import Decimal from 'decimal.js';

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

  it('persists candidate trades, snapshots, queue remainders, dual-friction fills, and gate periods', () => {
    const t = new Date('2026-08-03T00:00:00.000Z');
    store.insertPublicTrades([{
      tradeId: 101, side: 'sell', price: new Decimal('0.098'), volume: new Decimal(50), t,
    }]);
    store.insertPublicTrades([{
      tradeId: 101, side: 'sell', price: new Decimal('0.098'), volume: new Decimal(50), t,
    }]);
    store.insertCandidateSnapshot({
      asOf: t,
      raydiumMidUsd: new Decimal('0.1'), solUsd: new Decimal(100),
      krakenBid: new Decimal('0.099'), krakenAsk: new Decimal('0.101'),
      crossVenueDivergenceBps: new Decimal(0),
      book: { pair: 'BERT/USD', bids: [], asks: [], t },
      references: new Map([['500', {
        sizeBert: new Decimal(500), executableSellPriceUsd: new Decimal('0.1'), executableBuyPriceUsd: new Decimal('0.1'),
        sellImpactBps: new Decimal(2), buyImpactBps: new Decimal(3),
        sellRouteDeviationBps: new Decimal(0), buyRouteDeviationBps: new Decimal(0),
      }]]),
    }, t);
    store.upsertCandidateOrder({
      candidateOrderId: 'co1', rungIndex: 1, side: 'buy', distanceBps: '400', price: '0.09615',
      sizeBert: '500', remainingBert: '450', queueAheadAtPlacementBert: '100', queueAheadRemainingBert: '0',
      referencePriceUsd: '0.1', referenceImpactBps: '2', expectedGrossEdgeBps: '400',
      expectedNormalNetEdgeBps: '342', expectedStressNetEdgeBps: '306',
      economicSnapshotAt: t.toISOString(), placedAt: t.toISOString(), updatedAt: t.toISOString(),
    });
    store.closeCandidateOrder('co1', '450', t.toISOString(), 'cancel_on_fill');
    store.upsertCandidateFill({
      candidateFillId: 'cf1', candidateOrderId: 'co1', krakenTradeId: 101, hedgeBatchId: 'ch1', side: 'buy',
      distanceBps: '400', fillPriceUsd: '0.09615', volumeBert: '50', orderRemainingBert: '450',
      dexHedgePriceUsd: '0.1', dexImpactBps: '2', grossPnlUsd: '0.1925',
      normalMakerFeeUsd: '0.011', normalLatencyCostUsd: '0.01', normalFailureReserveUsd: '0.005',
      normalTransactionCostUsd: '0.02', normalNetPnlUsd: '0.1465',
      stressMakerFeeUsd: '0.012', stressLatencyCostUsd: '0.02', stressFailureReserveUsd: '0.01',
      stressTransactionCostUsd: '0.04', stressNetPnlUsd: '0.1105', hedgeStatus: 'pending',
      economicsSource: 'placement_reference', hedgeResolvedAt: null, hedgeTerminalReason: null, t: t.toISOString(),
    });
    expect(store.listPendingCandidateFills()).toHaveLength(1);
    store.abandonCandidateHedgeBatch('ch1', new Date(t.getTime() + 500).toISOString(), 'pending_hedge_expired');
    store.syncCandidateGatePeriods([{ gate: 'route_gate_buy_500', detailJson: '{"deviationBps":"80"}' }], t.toISOString());
    store.syncCandidateGatePeriods([], new Date(t.getTime() + 1000).toISOString());

    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    expect((db.prepare('SELECT COUNT(*) n FROM public_trades').get() as { n: number }).n).toBe(1);
    expect((db.prepare('SELECT remaining_bert,queue_ahead_at_placement_bert,close_reason FROM candidate_orders').get() as Record<string, string>))
      .toMatchObject({ remaining_bert: '450', queue_ahead_at_placement_bert: '100', close_reason: 'cancel_on_fill' });
    expect((db.prepare('SELECT normal_net_pnl_usd,stress_net_pnl_usd FROM candidate_fills').get() as Record<string, string>))
      .toEqual({ normal_net_pnl_usd: '0.1465', stress_net_pnl_usd: '0.1105' });
    expect((db.prepare('SELECT hedge_status,hedge_terminal_reason FROM candidate_fills').get() as Record<string, string>))
      .toEqual({ hedge_status: 'abandoned', hedge_terminal_reason: 'pending_hedge_expired' });
    expect((db.prepare('SELECT ended_at FROM candidate_gate_periods').get() as { ended_at: string }).ended_at).not.toBeNull();
  });

  it('enforces foreign keys and installs dashboard query indexes', () => {
    const db = (store as unknown as { db: import('better-sqlite3').Database }).db;
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => db.prepare(`INSERT INTO fills
      (fill_id,order_cl_ord_id,side,price,volume,fee,t) VALUES ('orphan','missing','buy','1','1','0','2026-08-03T00:00:00Z')`).run())
      .toThrow(/FOREIGN KEY/);
    const orderIndexes = db.pragma('index_list(candidate_orders)') as Array<{ name: string }>;
    const gateIndexes = db.pragma('index_list(candidate_gate_periods)') as Array<{ name: string }>;
    expect(orderIndexes.map(index => index.name)).toContain('idx_candidate_orders_updated_at');
    expect(gateIndexes.map(index => index.name)).toContain('idx_candidate_gate_started_at');
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

  it('sumInFlightHedgesBert nets signed hedge notionals (buy-hedges are negative)', () => {
    store.insertHedgeRow({ hedgeId:'s1', triggeringFillId:'f1', status:'tx_submitted', jupiterQuote:null, txSig:'x1', slippageRealized:null, bertNotional:'1000', tIntent:'2026-05-21T00:00:00Z', tConfirmed:null });
    store.insertHedgeRow({ hedgeId:'s2', triggeringFillId:'f2', status:'intent_queued', jupiterQuote:null, txSig:null, slippageRealized:null, bertNotional:'-400', tIntent:'2026-05-21T00:00:00Z', tConfirmed:null });
    const total = store.sumInFlightHedgesBert();
    expect(total.toString()).toBe('600');
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
