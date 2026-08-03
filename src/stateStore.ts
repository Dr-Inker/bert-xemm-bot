import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import Decimal from 'decimal.js';
import type { CandidateFillRecord, CandidateOrder, CandidatePendingFill } from './candidateFillEngine.js';
import type { CandidateEconomicSnapshot } from './candidateQuoteSampler.js';
import type { PublicTrade } from './venues/krakenPublicTrades.js';

export interface OrderRow {
  clOrdId: string;
  krakenTxid: string;
  side: 'buy' | 'sell';
  price: string;
  volume: string;
  status: 'open' | 'cancelled' | 'filled' | 'partially_filled' | 'rejected';
  placedAt: string;
  lastUpdated: string;
}

export interface BasisSampleRow {
  t: string;
  raydiumMidUsd: string;
  krakenBid: string;
  krakenAsk: string;
  solUsd: string;
  wouldHaveActed: boolean;
}

export interface ObserverSampleRow {
  t: string; sizeBert: string; raydiumMidUsd: string; krakenBid: string; krakenAsk: string;
  dexSellPriceUsd: string; dexBuyPriceUsd: string; makerFeeBps: number;
  buyMakerEdgeBps: string; sellMakerEdgeBps: string;
  dexSellImpactBps: string; dexBuyImpactBps: string;
  bookAgeMs: number; oracleTrusted: boolean;
}

export class StateStore {
  private db: DB;
  constructor(path: string) {
    this.db = new Database(path);
    // Enforce the declared order/trade relationships on all new writes.
    // Existing rows are not retroactively rejected by SQLite.
    this.db.pragma('foreign_keys = ON');
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        cl_ord_id TEXT PRIMARY KEY,
        kraken_txid TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy','sell')),
        price TEXT NOT NULL,
        volume TEXT NOT NULL,
        status TEXT NOT NULL,
        placed_at TEXT NOT NULL,
        last_updated TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fills (
        fill_id TEXT PRIMARY KEY,
        order_cl_ord_id TEXT NOT NULL,
        side TEXT NOT NULL,
        price TEXT NOT NULL,
        volume TEXT NOT NULL,
        fee TEXT NOT NULL,
        t TEXT NOT NULL,
        FOREIGN KEY (order_cl_ord_id) REFERENCES orders(cl_ord_id)
      );
      CREATE TABLE IF NOT EXISTS hedges (
        hedge_id TEXT PRIMARY KEY,
        triggering_fill_id TEXT NOT NULL,
        status TEXT NOT NULL,
        jupiter_quote TEXT,
        tx_sig TEXT,
        slippage_realized TEXT,
        bert_notional TEXT,
        t_intent TEXT NOT NULL,
        t_confirmed TEXT
      );
      CREATE TABLE IF NOT EXISTS basis_samples (
        t TEXT NOT NULL,
        raydium_mid_usd TEXT NOT NULL,
        kraken_bid TEXT NOT NULL,
        kraken_ask TEXT NOT NULL,
        sol_usd TEXT NOT NULL,
        would_have_acted INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_basis_t ON basis_samples(t);
      CREATE TABLE IF NOT EXISTS observer_samples (
        t TEXT NOT NULL, size_bert TEXT NOT NULL, raydium_mid_usd TEXT NOT NULL,
        kraken_bid TEXT NOT NULL, kraken_ask TEXT NOT NULL,
        dex_sell_price_usd TEXT NOT NULL, dex_buy_price_usd TEXT NOT NULL,
        maker_fee_bps REAL NOT NULL, buy_maker_edge_bps TEXT NOT NULL,
        sell_maker_edge_bps TEXT NOT NULL, dex_sell_impact_bps TEXT NOT NULL,
        dex_buy_impact_bps TEXT NOT NULL, book_age_ms INTEGER NOT NULL,
        oracle_trusted INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_observer_samples_t_size ON observer_samples(t, size_bert);
      CREATE TABLE IF NOT EXISTS paper_orders (
        paper_order_id TEXT PRIMARY KEY, side TEXT NOT NULL, price TEXT NOT NULL,
        size_bert TEXT NOT NULL, queue_ahead_bert TEXT NOT NULL, expected_edge_bps TEXT NOT NULL,
        status TEXT NOT NULL, placed_at TEXT NOT NULL, updated_at TEXT NOT NULL, close_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_paper_orders_status ON paper_orders(status);
      CREATE TABLE IF NOT EXISTS paper_fills (
        paper_fill_id TEXT PRIMARY KEY, paper_order_id TEXT NOT NULL, kraken_trade_id INTEGER NOT NULL,
        side TEXT NOT NULL, fill_price_usd TEXT NOT NULL, volume_bert TEXT NOT NULL,
        dex_hedge_price_usd TEXT NOT NULL, gross_pnl_usd TEXT NOT NULL, maker_fee_usd TEXT NOT NULL,
        transaction_cost_usd TEXT NOT NULL, latency_cost_usd TEXT NOT NULL,
        failure_reserve_usd TEXT NOT NULL, net_pnl_usd TEXT NOT NULL, dex_impact_bps TEXT NOT NULL,
        t TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_paper_fills_t ON paper_fills(t);
      CREATE TABLE IF NOT EXISTS public_trades (
        trade_id INTEGER PRIMARY KEY, t TEXT NOT NULL, price TEXT NOT NULL,
        volume TEXT NOT NULL, side TEXT CHECK (side IN ('buy','sell')), received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_public_trades_t ON public_trades(t);
      CREATE TABLE IF NOT EXISTS candidate_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, t TEXT NOT NULL, size_bert TEXT NOT NULL,
        raydium_mid_usd TEXT NOT NULL, kraken_bid TEXT NOT NULL, kraken_ask TEXT NOT NULL,
        cross_venue_divergence_bps TEXT NOT NULL, book_age_ms INTEGER NOT NULL,
        executable_sell_price_usd TEXT NOT NULL, executable_buy_price_usd TEXT NOT NULL,
        sell_route_deviation_bps TEXT NOT NULL, buy_route_deviation_bps TEXT NOT NULL,
        sell_impact_bps TEXT NOT NULL, buy_impact_bps TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_candidate_snapshots_t_size ON candidate_snapshots(t, size_bert);
      CREATE TABLE IF NOT EXISTS candidate_orders (
        candidate_order_id TEXT PRIMARY KEY, rung_index INTEGER NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy','sell')), distance_bps TEXT NOT NULL,
        price TEXT NOT NULL, size_bert TEXT NOT NULL, remaining_bert TEXT NOT NULL,
        queue_ahead_at_placement_bert TEXT NOT NULL, queue_ahead_remaining_bert TEXT NOT NULL,
        reference_price_usd TEXT NOT NULL, reference_impact_bps TEXT NOT NULL,
        expected_gross_edge_bps TEXT NOT NULL, expected_normal_net_edge_bps TEXT NOT NULL,
        expected_stress_net_edge_bps TEXT NOT NULL, economic_snapshot_at TEXT NOT NULL,
        status TEXT NOT NULL, placed_at TEXT NOT NULL, updated_at TEXT NOT NULL, close_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_candidate_orders_status ON candidate_orders(status);
      CREATE INDEX IF NOT EXISTS idx_candidate_orders_updated_at ON candidate_orders(updated_at);
      CREATE TABLE IF NOT EXISTS candidate_fills (
        candidate_fill_id TEXT PRIMARY KEY, candidate_order_id TEXT NOT NULL,
        kraken_trade_id INTEGER NOT NULL, hedge_batch_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy','sell')), distance_bps TEXT NOT NULL,
        fill_price_usd TEXT NOT NULL, volume_bert TEXT NOT NULL, order_remaining_bert TEXT NOT NULL,
        dex_hedge_price_usd TEXT NOT NULL, dex_impact_bps TEXT NOT NULL, gross_pnl_usd TEXT NOT NULL,
        normal_maker_fee_usd TEXT NOT NULL, normal_latency_cost_usd TEXT NOT NULL,
        normal_failure_reserve_usd TEXT NOT NULL, normal_transaction_cost_usd TEXT NOT NULL,
        normal_net_pnl_usd TEXT NOT NULL, stress_maker_fee_usd TEXT NOT NULL,
        stress_latency_cost_usd TEXT NOT NULL, stress_failure_reserve_usd TEXT NOT NULL,
        stress_transaction_cost_usd TEXT NOT NULL, stress_net_pnl_usd TEXT NOT NULL,
        hedge_status TEXT NOT NULL, economics_source TEXT NOT NULL,
        hedge_resolved_at TEXT, hedge_terminal_reason TEXT, t TEXT NOT NULL,
        FOREIGN KEY (candidate_order_id) REFERENCES candidate_orders(candidate_order_id),
        FOREIGN KEY (kraken_trade_id) REFERENCES public_trades(trade_id)
      );
      CREATE INDEX IF NOT EXISTS idx_candidate_fills_t ON candidate_fills(t);
      CREATE INDEX IF NOT EXISTS idx_candidate_fills_batch ON candidate_fills(hedge_batch_id);
      CREATE TABLE IF NOT EXISTS candidate_gate_periods (
        id INTEGER PRIMARY KEY AUTOINCREMENT, gate TEXT NOT NULL, started_at TEXT NOT NULL,
        ended_at TEXT, detail_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_gate_open
        ON candidate_gate_periods(gate) WHERE ended_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_candidate_gate_started_at ON candidate_gate_periods(started_at);
      CREATE TABLE IF NOT EXISTS kill_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        t TEXT NOT NULL,
        condition_id INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        action_taken TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flags (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Idempotent column add for DBs created before bert_notional existed.
    // SQLite errors if the column is already present; swallow safely.
    try { this.db.exec("ALTER TABLE hedges ADD COLUMN bert_notional TEXT"); } catch { /* column already exists */ }
    try { this.db.exec("ALTER TABLE candidate_fills ADD COLUMN hedge_resolved_at TEXT"); } catch { /* column already exists */ }
    try { this.db.exec("ALTER TABLE candidate_fills ADD COLUMN hedge_terminal_reason TEXT"); } catch { /* column already exists */ }
  }

  insertOrder(r: OrderRow): void {
    this.db.prepare(`
      INSERT INTO orders (cl_ord_id, kraken_txid, side, price, volume, status, placed_at, last_updated)
      VALUES (@clOrdId, @krakenTxid, @side, @price, @volume, @status, @placedAt, @lastUpdated)
    `).run(r);
  }

  getOrderByClOrdId(clOrdId: string): OrderRow | null {
    const r = this.db.prepare(`
      SELECT cl_ord_id AS clOrdId, kraken_txid AS krakenTxid, side, price, volume,
             status, placed_at AS placedAt, last_updated AS lastUpdated
      FROM orders WHERE cl_ord_id = ?
    `).get(clOrdId) as OrderRow | undefined;
    return r ?? null;
  }

  insertBasisSample(r: BasisSampleRow): void {
    this.db.prepare(`
      INSERT INTO basis_samples (t, raydium_mid_usd, kraken_bid, kraken_ask, sol_usd, would_have_acted)
      VALUES (@t, @raydiumMidUsd, @krakenBid, @krakenAsk, @solUsd, @wouldHaveActed)
    `).run({ ...r, wouldHaveActed: r.wouldHaveActed ? 1 : 0 });
  }

  recentBasisSamples(limit: number): BasisSampleRow[] {
    const rows = this.db.prepare(`
      SELECT t, raydium_mid_usd AS raydiumMidUsd, kraken_bid AS krakenBid,
             kraken_ask AS krakenAsk, sol_usd AS solUsd, would_have_acted AS wouldHaveActed
      FROM basis_samples ORDER BY t DESC LIMIT ?
    `).all(limit) as Array<Omit<BasisSampleRow, 'wouldHaveActed'> & { wouldHaveActed: number }>;
    return rows.map(r => ({ ...r, wouldHaveActed: r.wouldHaveActed === 1 }));
  }

  insertObserverSample(r: ObserverSampleRow): void {
    this.db.prepare(`
      INSERT INTO observer_samples (
        t, size_bert, raydium_mid_usd, kraken_bid, kraken_ask,
        dex_sell_price_usd, dex_buy_price_usd, maker_fee_bps,
        buy_maker_edge_bps, sell_maker_edge_bps, dex_sell_impact_bps,
        dex_buy_impact_bps, book_age_ms, oracle_trusted
      ) VALUES (
        @t, @sizeBert, @raydiumMidUsd, @krakenBid, @krakenAsk,
        @dexSellPriceUsd, @dexBuyPriceUsd, @makerFeeBps,
        @buyMakerEdgeBps, @sellMakerEdgeBps, @dexSellImpactBps,
        @dexBuyImpactBps, @bookAgeMs, @oracleTrusted
      )
    `).run({ ...r, oracleTrusted: r.oracleTrusted ? 1 : 0 });
  }

  recentObserverSamples(limit: number): ObserverSampleRow[] {
    const rows = this.db.prepare(`
      SELECT t, size_bert AS sizeBert, raydium_mid_usd AS raydiumMidUsd,
        kraken_bid AS krakenBid, kraken_ask AS krakenAsk,
        dex_sell_price_usd AS dexSellPriceUsd, dex_buy_price_usd AS dexBuyPriceUsd,
        maker_fee_bps AS makerFeeBps, buy_maker_edge_bps AS buyMakerEdgeBps,
        sell_maker_edge_bps AS sellMakerEdgeBps, dex_sell_impact_bps AS dexSellImpactBps,
        dex_buy_impact_bps AS dexBuyImpactBps, book_age_ms AS bookAgeMs,
        oracle_trusted AS oracleTrusted
      FROM observer_samples ORDER BY t DESC LIMIT ?
    `).all(limit) as Array<Omit<ObserverSampleRow, 'oracleTrusted'> & { oracleTrusted: number }>;
    return rows.map(r => ({ ...r, oracleTrusted: r.oracleTrusted === 1 }));
  }

  upsertPaperOrder(r: { paperOrderId: string; side: 'buy'|'sell'; price: string; sizeBert: string; queueAheadBert: string; expectedEdgeBps: string; placedAt: string; updatedAt: string }): void {
    this.db.prepare(`INSERT INTO paper_orders
      (paper_order_id, side, price, size_bert, queue_ahead_bert, expected_edge_bps, status, placed_at, updated_at)
      VALUES (@paperOrderId,@side,@price,@sizeBert,@queueAheadBert,@expectedEdgeBps,'open',@placedAt,@updatedAt)
      ON CONFLICT(paper_order_id) DO UPDATE SET queue_ahead_bert=excluded.queue_ahead_bert, updated_at=excluded.updated_at
    `).run(r);
  }

  cancelPaperOrder(id: string, t: string, reason: string): void {
    this.db.prepare(`UPDATE paper_orders SET status=?, close_reason=?, updated_at=? WHERE paper_order_id=?`).run(reason === 'filled' ? 'filled' : 'cancelled', reason, t, id);
  }

  cancelAllOpenPaperOrders(t: string, reason: string): void {
    this.db.prepare(`UPDATE paper_orders SET status='cancelled', close_reason=?, updated_at=? WHERE status='open'`).run(reason, t);
  }

  insertPaperFill(r: Record<string, string | number>): void {
    this.db.prepare(`INSERT OR IGNORE INTO paper_fills
      (paper_fill_id,paper_order_id,kraken_trade_id,side,fill_price_usd,volume_bert,dex_hedge_price_usd,
       gross_pnl_usd,maker_fee_usd,transaction_cost_usd,latency_cost_usd,failure_reserve_usd,net_pnl_usd,dex_impact_bps,t)
      VALUES (@paperFillId,@paperOrderId,@krakenTradeId,@side,@fillPriceUsd,@volumeBert,@dexHedgePriceUsd,
       @grossPnlUsd,@makerFeeUsd,@transactionCostUsd,@latencyCostUsd,@failureReserveUsd,@netPnlUsd,@dexImpactBps,@t)
    `).run(r);
  }

  insertPublicTrades(trades: PublicTrade[], receivedAt = new Date()): void {
    const insert = this.db.prepare(`INSERT OR IGNORE INTO public_trades
      (trade_id,t,price,volume,side,received_at) VALUES (@tradeId,@t,@price,@volume,@side,@receivedAt)`);
    const receivedAtIso = receivedAt.toISOString();
    this.withTransaction(() => {
      for (const trade of trades) {
        insert.run({
          tradeId: trade.tradeId,
          t: trade.t.toISOString(),
          price: trade.price.toString(),
          volume: trade.volume.toString(),
          side: trade.side,
          receivedAt: receivedAtIso,
        });
      }
    });
  }

  insertCandidateSnapshot(snapshot: CandidateEconomicSnapshot, recordedAt = new Date()): void {
    const insert = this.db.prepare(`INSERT INTO candidate_snapshots
      (t,size_bert,raydium_mid_usd,kraken_bid,kraken_ask,cross_venue_divergence_bps,book_age_ms,
       executable_sell_price_usd,executable_buy_price_usd,sell_route_deviation_bps,buy_route_deviation_bps,
       sell_impact_bps,buy_impact_bps)
      VALUES (@t,@sizeBert,@raydiumMidUsd,@krakenBid,@krakenAsk,@crossVenueDivergenceBps,@bookAgeMs,
       @executableSellPriceUsd,@executableBuyPriceUsd,@sellRouteDeviationBps,@buyRouteDeviationBps,
       @sellImpactBps,@buyImpactBps)`);
    const bookAgeMs = Math.max(0, recordedAt.getTime() - snapshot.book.t.getTime());
    this.withTransaction(() => {
      for (const reference of snapshot.references.values()) {
        insert.run({
          t: snapshot.asOf.toISOString(),
          sizeBert: reference.sizeBert.toString(),
          raydiumMidUsd: snapshot.raydiumMidUsd.toString(),
          krakenBid: snapshot.krakenBid.toString(),
          krakenAsk: snapshot.krakenAsk.toString(),
          crossVenueDivergenceBps: snapshot.crossVenueDivergenceBps.toString(),
          bookAgeMs,
          executableSellPriceUsd: reference.executableSellPriceUsd.toString(),
          executableBuyPriceUsd: reference.executableBuyPriceUsd.toString(),
          sellRouteDeviationBps: reference.sellRouteDeviationBps.toString(),
          buyRouteDeviationBps: reference.buyRouteDeviationBps.toString(),
          sellImpactBps: reference.sellImpactBps.toString(),
          buyImpactBps: reference.buyImpactBps.toString(),
        });
      }
    });
  }

  upsertCandidateOrder(r: CandidateOrder): void {
    this.db.prepare(`INSERT INTO candidate_orders
      (candidate_order_id,rung_index,side,distance_bps,price,size_bert,remaining_bert,
       queue_ahead_at_placement_bert,queue_ahead_remaining_bert,reference_price_usd,reference_impact_bps,
       expected_gross_edge_bps,expected_normal_net_edge_bps,expected_stress_net_edge_bps,
       economic_snapshot_at,status,placed_at,updated_at)
      VALUES (@candidateOrderId,@rungIndex,@side,@distanceBps,@price,@sizeBert,@remainingBert,
       @queueAheadAtPlacementBert,@queueAheadRemainingBert,@referencePriceUsd,@referenceImpactBps,
       @expectedGrossEdgeBps,@expectedNormalNetEdgeBps,@expectedStressNetEdgeBps,
       @economicSnapshotAt,'open',@placedAt,@updatedAt)
      ON CONFLICT(candidate_order_id) DO UPDATE SET
       remaining_bert=excluded.remaining_bert,
       queue_ahead_remaining_bert=excluded.queue_ahead_remaining_bert,
       reference_price_usd=excluded.reference_price_usd,
       reference_impact_bps=excluded.reference_impact_bps,
       expected_gross_edge_bps=excluded.expected_gross_edge_bps,
       expected_normal_net_edge_bps=excluded.expected_normal_net_edge_bps,
       expected_stress_net_edge_bps=excluded.expected_stress_net_edge_bps,
       economic_snapshot_at=excluded.economic_snapshot_at,
       updated_at=excluded.updated_at`).run(r);
  }

  closeCandidateOrder(id: string, remainingBert: string, t: string, reason: string): void {
    this.db.prepare(`UPDATE candidate_orders SET status=?,remaining_bert=?,close_reason=?,updated_at=?
      WHERE candidate_order_id=? AND status='open'`)
      .run(reason === 'filled' ? 'filled' : 'cancelled', remainingBert, reason, t, id);
  }

  cancelAllOpenCandidateOrders(t: string, reason: string): void {
    this.db.prepare(`UPDATE candidate_orders SET status='cancelled',close_reason=?,updated_at=? WHERE status='open'`)
      .run(reason, t);
  }

  upsertCandidateFill(r: CandidateFillRecord): void {
    this.db.prepare(`INSERT INTO candidate_fills
      (candidate_fill_id,candidate_order_id,kraken_trade_id,hedge_batch_id,side,distance_bps,
       fill_price_usd,volume_bert,order_remaining_bert,dex_hedge_price_usd,dex_impact_bps,gross_pnl_usd,
       normal_maker_fee_usd,normal_latency_cost_usd,normal_failure_reserve_usd,normal_transaction_cost_usd,
       normal_net_pnl_usd,stress_maker_fee_usd,stress_latency_cost_usd,stress_failure_reserve_usd,
       stress_transaction_cost_usd,stress_net_pnl_usd,hedge_status,economics_source,
       hedge_resolved_at,hedge_terminal_reason,t)
      VALUES (@candidateFillId,@candidateOrderId,@krakenTradeId,@hedgeBatchId,@side,@distanceBps,
       @fillPriceUsd,@volumeBert,@orderRemainingBert,@dexHedgePriceUsd,@dexImpactBps,@grossPnlUsd,
       @normalMakerFeeUsd,@normalLatencyCostUsd,@normalFailureReserveUsd,@normalTransactionCostUsd,
       @normalNetPnlUsd,@stressMakerFeeUsd,@stressLatencyCostUsd,@stressFailureReserveUsd,
       @stressTransactionCostUsd,@stressNetPnlUsd,@hedgeStatus,@economicsSource,
       @hedgeResolvedAt,@hedgeTerminalReason,@t)
      ON CONFLICT(candidate_fill_id) DO UPDATE SET
       dex_hedge_price_usd=excluded.dex_hedge_price_usd,
       dex_impact_bps=excluded.dex_impact_bps,
       gross_pnl_usd=excluded.gross_pnl_usd,
       normal_maker_fee_usd=excluded.normal_maker_fee_usd,
       normal_latency_cost_usd=excluded.normal_latency_cost_usd,
       normal_failure_reserve_usd=excluded.normal_failure_reserve_usd,
       normal_transaction_cost_usd=excluded.normal_transaction_cost_usd,
       normal_net_pnl_usd=excluded.normal_net_pnl_usd,
       stress_maker_fee_usd=excluded.stress_maker_fee_usd,
       stress_latency_cost_usd=excluded.stress_latency_cost_usd,
       stress_failure_reserve_usd=excluded.stress_failure_reserve_usd,
       stress_transaction_cost_usd=excluded.stress_transaction_cost_usd,
       stress_net_pnl_usd=excluded.stress_net_pnl_usd,
       hedge_status=excluded.hedge_status,
       economics_source=excluded.economics_source,
       hedge_resolved_at=excluded.hedge_resolved_at,
       hedge_terminal_reason=excluded.hedge_terminal_reason`).run(r);
  }

  abandonCandidateHedgeBatch(batchId: string, t: string, reason: string): void {
    this.db.prepare(`UPDATE candidate_fills
      SET hedge_status='abandoned',hedge_resolved_at=?,hedge_terminal_reason=?
      WHERE hedge_batch_id=? AND hedge_status='pending'`).run(t, reason, batchId);
  }

  listPendingCandidateFills(): CandidatePendingFill[] {
    return this.db.prepare(`SELECT
      f.candidate_fill_id AS candidateFillId,
      f.candidate_order_id AS candidateOrderId,
      f.kraken_trade_id AS krakenTradeId,
      f.hedge_batch_id AS hedgeBatchId,
      f.side,
      f.distance_bps AS distanceBps,
      f.fill_price_usd AS fillPriceUsd,
      f.volume_bert AS volumeBert,
      f.order_remaining_bert AS orderRemainingBert,
      o.reference_price_usd AS referencePriceUsd,
      o.reference_impact_bps AS referenceImpactBps,
      f.t
      FROM candidate_fills f
      JOIN candidate_orders o ON o.candidate_order_id=f.candidate_order_id
      WHERE f.hedge_status='pending'
      ORDER BY f.t,f.candidate_fill_id`).all() as CandidatePendingFill[];
  }

  syncCandidateGatePeriods(gates: Array<{ gate: string; detailJson: string }>, t: string): void {
    const active = new Map(gates.map(gate => [gate.gate, gate.detailJson]));
    this.withTransaction(() => {
      const open = this.db.prepare(`SELECT gate FROM candidate_gate_periods WHERE ended_at IS NULL`).all() as Array<{ gate: string }>;
      const close = this.db.prepare(`UPDATE candidate_gate_periods SET ended_at=? WHERE gate=? AND ended_at IS NULL`);
      const update = this.db.prepare(`UPDATE candidate_gate_periods SET detail_json=? WHERE gate=? AND ended_at IS NULL`);
      const insert = this.db.prepare(`INSERT INTO candidate_gate_periods (gate,started_at,detail_json) VALUES (?,?,?)`);
      for (const row of open) {
        if (!active.has(row.gate)) close.run(t, row.gate);
        else update.run(active.get(row.gate), row.gate);
      }
      const openNames = new Set(open.map(row => row.gate));
      for (const [gate, detailJson] of active) if (!openNames.has(gate)) insert.run(gate, t, detailJson);
    });
  }

  setFlag(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO flags (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getFlag(key: string): string | null {
    const r = this.db.prepare(`SELECT value FROM flags WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  basisSamplesSince(iso: string): Array<{ t: string; raydiumMidUsd: string; krakenBid: string; krakenAsk: string; solUsd: string; wouldHaveActed: boolean }> {
    const rows = this.db.prepare(`
      SELECT t, raydium_mid_usd AS raydiumMidUsd, kraken_bid AS krakenBid, kraken_ask AS krakenAsk, sol_usd AS solUsd, would_have_acted AS wouldHaveActed
      FROM basis_samples WHERE t >= ? ORDER BY t ASC
    `).all(iso) as Array<{ t: string; raydiumMidUsd: string; krakenBid: string; krakenAsk: string; solUsd: string; wouldHaveActed: number }>;
    return rows.map(r => ({ ...r, wouldHaveActed: r.wouldHaveActed === 1 }));
  }

  countFillsSince(iso: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM fills WHERE t >= ?`).get(iso) as { n: number };
    return r.n;
  }

  listOpenOrders(): Array<{ venueOrderId: string; clOrdId: string }> {
    const rows = this.db.prepare(`
      SELECT cl_ord_id AS clOrdId, kraken_txid AS venueOrderId
      FROM orders
      WHERE status = 'open'
    `).all() as Array<{ clOrdId: string; venueOrderId: string }>;
    return rows;
  }

  insertKillEvent(r: { t: string; conditionId: number; snapshotJson: string; actionTaken: string }): void {
    this.db.prepare(`
      INSERT INTO kill_events (t, condition_id, snapshot_json, action_taken)
      VALUES (@t, @conditionId, @snapshotJson, @actionTaken)
    `).run(r);
  }

  insertHedgeRow(r: {
    hedgeId: string; triggeringFillId: string; status: string;
    jupiterQuote: string | null; txSig: string | null; slippageRealized: string | null;
    bertNotional: string; tIntent: string; tConfirmed: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO hedges (hedge_id, triggering_fill_id, status, jupiter_quote, tx_sig, slippage_realized, bert_notional, t_intent, t_confirmed)
      VALUES (@hedgeId, @triggeringFillId, @status, @jupiterQuote, @txSig, @slippageRealized, @bertNotional, @tIntent, @tConfirmed)
      ON CONFLICT(hedge_id) DO UPDATE SET
        status=excluded.status,
        jupiter_quote=excluded.jupiter_quote,
        tx_sig=excluded.tx_sig,
        slippage_realized=excluded.slippage_realized,
        bert_notional=excluded.bert_notional,
        t_confirmed=excluded.t_confirmed
    `).run(r);
  }

  markHedgeConfirmed(hedgeId: string, txSig: string, slippageRealized: string): void {
    this.db.prepare(`
      UPDATE hedges SET status='confirmed', tx_sig=?, slippage_realized=?, t_confirmed=?
      WHERE hedge_id=?
    `).run(txSig, slippageRealized, new Date().toISOString(), hedgeId);
  }

  markHedgeFailed(hedgeId: string, status: string): void {
    this.db.prepare(`UPDATE hedges SET status=? WHERE hedge_id=?`).run(status, hedgeId);
  }

  sumInFlightHedgesBert(): Decimal {
    const rows = this.db.prepare(`
      SELECT bert_notional FROM hedges
      WHERE status IN ('intent_queued','swap_quoted','tx_submitted','failed_will_retry')
    `).all() as Array<{ bert_notional: string | null }>;
    let total = new Decimal(0);
    for (const r of rows) if (r.bert_notional) total = total.plus(new Decimal(r.bert_notional));
    return total;
  }

  withTransaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }
}
