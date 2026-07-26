import Decimal from 'decimal.js';
import type { BookSnapshot, Side } from './types.js';
import type { PublicTrade } from './venues/krakenPublicTrades.js';

export interface PaperQuoteCandidate {
  sizeBert: Decimal;
  side: Side;
  price: Decimal;
  expectedEdgeBps: Decimal;
  book: BookSnapshot;
  oracleTrusted: boolean;
}
export interface PaperFillEconomics {
  dexPriceUsd: Decimal;
  makerFeeUsd: Decimal;
  dexImpactBps: Decimal;
}
export interface PaperOrder {
  paperOrderId: string; side: Side; price: string; sizeBert: string; queueAheadBert: string;
  expectedEdgeBps: string; placedAt: string; updatedAt: string;
}

export interface PaperFillEngineOpts {
  minNetEdgeBps: number;
  driftThresholdBps: number;
  latencyPenaltyBps: number;
  failedHedgeReserveBps: number;
  transactionCostUsd: number;
  store: {
    upsertPaperOrder(o: PaperOrder): void;
    cancelPaperOrder(id: string, t: string, reason: string): void;
    insertPaperFill(f: Record<string, string | number>): void;
  };
  hedgeAtFill: (side: Side, size: Decimal, fillPrice: Decimal) => Promise<PaperFillEconomics>;
}

export class PaperFillEngine {
  private orders = new Map<string, PaperOrder>();
  private seenTradeIds = new Set<number>();
  private processing = Promise.resolve();
  constructor(private o: PaperFillEngineOpts) {}

  updateQuotes(candidates: PaperQuoteCandidate[], now = new Date()): void {
    const keep = new Set<string>();
    for (const c of candidates) {
      const key = orderKey(c.side, c.sizeBert);
      if (!c.oracleTrusted || c.expectedEdgeBps.lt(this.o.minNetEdgeBps)) continue;
      keep.add(key);
      const price = postOnlyPrice(c);
      const existing = this.orders.get(key);
      const drift = existing ? price.minus(existing.price).abs().div(existing.price).mul(10_000) : new Decimal(Infinity);
      if (existing && drift.lte(this.o.driftThresholdBps)) continue;
      if (existing) this.o.store.cancelPaperOrder(existing.paperOrderId, now.toISOString(), 'requote');
      const order: PaperOrder = {
        paperOrderId: `paper-${key}-${now.getTime()}`, side: c.side, price: price.toString(),
        sizeBert: c.sizeBert.toString(), queueAheadBert: queueAhead(c.book, c.side, price).toString(),
        expectedEdgeBps: c.expectedEdgeBps.toString(), placedAt: now.toISOString(), updatedAt: now.toISOString(),
      };
      this.orders.set(key, order); this.o.store.upsertPaperOrder(order);
    }
    for (const [key, order] of this.orders) if (!keep.has(key)) {
      this.o.store.cancelPaperOrder(order.paperOrderId, now.toISOString(), 'untrusted_or_unprofitable');
      this.orders.delete(key);
    }
  }

  onTrade(trade: PublicTrade): Promise<void> {
    this.processing = this.processing.then(() => this.processTrade(trade));
    return this.processing;
  }

  private async processTrade(t: PublicTrade): Promise<void> {
    if (this.seenTradeIds.has(t.tradeId)) return;
    this.seenTradeIds.add(t.tradeId);
    if (this.seenTradeIds.size > 20_000) this.seenTradeIds = new Set([...this.seenTradeIds].slice(-10_000));
    const hitSide: Side = t.side === 'sell' ? 'buy' : 'sell';
    for (const [key, order] of [...this.orders]) {
      if (order.side !== hitSide || !tradesThrough(t, order)) continue;
      const ahead = new Decimal(order.queueAheadBert);
      if (t.volume.lte(ahead)) {
        order.queueAheadBert = ahead.minus(t.volume).toString(); order.updatedAt = t.t.toISOString();
        this.o.store.upsertPaperOrder(order); continue;
      }
      const fillVolume = Decimal.min(new Decimal(order.sizeBert), t.volume.minus(ahead));
      if (fillVolume.lte(0)) continue;
      await this.recordFill(order, fillVolume, t);
      this.orders.delete(key);
    }
  }

  private async recordFill(order: PaperOrder, volume: Decimal, trade: PublicTrade): Promise<void> {
    const price = new Decimal(order.price);
    const hedge = await this.o.hedgeAtFill(order.side, volume, price);
    const notional = price.mul(volume);
    const gross = order.side === 'buy'
      ? hedge.dexPriceUsd.minus(price).mul(volume)
      : price.minus(hedge.dexPriceUsd).mul(volume);
    const latencyCost = hedge.dexPriceUsd.mul(volume).mul(this.o.latencyPenaltyBps).div(10_000);
    const failureReserve = hedge.dexPriceUsd.mul(volume).mul(this.o.failedHedgeReserveBps).div(10_000);
    const transactionCost = new Decimal(this.o.transactionCostUsd);
    const net = gross.minus(hedge.makerFeeUsd).minus(latencyCost).minus(failureReserve).minus(transactionCost);
    this.o.store.cancelPaperOrder(order.paperOrderId, trade.t.toISOString(), 'filled');
    this.o.store.insertPaperFill({
      paperFillId: `pf-${trade.tradeId}-${order.side}-${order.sizeBert}`, paperOrderId: order.paperOrderId,
      krakenTradeId: trade.tradeId, side: order.side, fillPriceUsd: price.toString(), volumeBert: volume.toString(),
      dexHedgePriceUsd: hedge.dexPriceUsd.toString(), grossPnlUsd: gross.toString(), makerFeeUsd: hedge.makerFeeUsd.toString(),
      transactionCostUsd: transactionCost.toString(), latencyCostUsd: latencyCost.toString(), failureReserveUsd: failureReserve.toString(),
      netPnlUsd: net.toString(), dexImpactBps: hedge.dexImpactBps.toString(), t: trade.t.toISOString(),
    });
  }
}

function orderKey(side: Side, size: Decimal): string { return `${side}-${size.toString()}`; }
function postOnlyPrice(c: PaperQuoteCandidate): Decimal {
  const tick = new Decimal('0.000001');
  const bid = c.book.bids[0]?.price; const ask = c.book.asks[0]?.price;
  if (!bid || !ask) return c.price;
  return c.side === 'buy' ? Decimal.min(c.price, ask.minus(tick)) : Decimal.max(c.price, bid.plus(tick));
}
function queueAhead(book: BookSnapshot, side: Side, price: Decimal): Decimal {
  const levels = side === 'buy' ? book.bids : book.asks;
  return levels.filter(l => side === 'buy' ? l.price.gte(price) : l.price.lte(price)).reduce((n, l) => n.plus(l.volume), new Decimal(0));
}
function tradesThrough(t: PublicTrade, o: PaperOrder): boolean {
  const p = new Decimal(o.price);
  return o.side === 'buy' ? t.price.lte(p) : t.price.gte(p);
}
