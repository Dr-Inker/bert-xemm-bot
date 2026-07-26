import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import Decimal from 'decimal.js';

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
