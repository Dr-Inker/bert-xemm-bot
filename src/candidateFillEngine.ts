import Decimal from 'decimal.js';
import type { BookSnapshot, Side } from './types.js';
import type { PublicTrade } from './venues/krakenPublicTrades.js';
import type { CandidateEconomicSnapshot, CandidateReference } from './candidateQuoteSampler.js';

export interface CandidateFriction {
  makerFeeBps: number;
  latencyPenaltyBps: number;
  failedHedgeReserveBps: number;
  transactionCostUsd: number;
}

export interface CandidateLadderRung {
  sizeBert: number;
  distanceBps: number;
}

export interface CandidateOrder {
  candidateOrderId: string;
  strategyFingerprint: string;
  rungIndex: number;
  side: Side;
  distanceBps: string;
  price: string;
  sizeBert: string;
  remainingBert: string;
  queueAheadAtPlacementBert: string;
  queueAheadRemainingBert: string;
  referencePriceUsd: string;
  referenceImpactBps: string;
  expectedGrossEdgeBps: string;
  expectedNormalNetEdgeBps: string;
  expectedStressNetEdgeBps: string;
  economicSnapshotAt: string;
  placedAt: string;
  updatedAt: string;
}

export interface CandidateFillRecord {
  candidateFillId: string;
  strategyFingerprint: string;
  candidateOrderId: string;
  krakenTradeId: number;
  hedgeBatchId: string;
  side: Side;
  distanceBps: string;
  fillPriceUsd: string;
  volumeBert: string;
  orderRemainingBert: string;
  dexHedgePriceUsd: string;
  dexImpactBps: string;
  grossPnlUsd: string;
  normalMakerFeeUsd: string;
  normalLatencyCostUsd: string;
  normalFailureReserveUsd: string;
  normalTransactionCostUsd: string;
  normalNetPnlUsd: string;
  stressMakerFeeUsd: string;
  stressLatencyCostUsd: string;
  stressFailureReserveUsd: string;
  stressTransactionCostUsd: string;
  stressNetPnlUsd: string;
  hedgeStatus: 'pending' | 'simulated' | 'abandoned';
  economicsSource: 'placement_reference' | 'fill_time_executable' | 'restart_recovered_executable';
  hedgeResolvedAt: string | null;
  hedgeTerminalReason: string | null;
  t: string;
}

export interface CandidateHedgeResult {
  dexPriceUsd: Decimal;
  dexImpactBps: Decimal;
}

export interface CandidatePendingFill {
  candidateFillId: string;
  candidateOrderId: string;
  strategyFingerprint: string;
  krakenTradeId: number;
  hedgeBatchId: string;
  side: Side;
  distanceBps: string;
  fillPriceUsd: string;
  volumeBert: string;
  orderRemainingBert: string;
  referencePriceUsd: string;
  referenceImpactBps: string;
  t: string;
}

export interface CandidateFillEngineOpts {
  strategyFingerprint: string;
  ladder: CandidateLadderRung[];
  minAllInEdgeBps: number;
  repriceThresholdBps: number;
  maxQuoteAgeMs: number;
  crossVenueMaxBps: number;
  routeVsReserveMaxBps: number;
  maxBookAgeSec: number;
  drift5sBps: number;
  drift30sBps: number;
  driftResumeStableSec: number;
  maxPendingHedgeAgeMs: number;
  maxActivePerSideBert: number;
  normalFriction: CandidateFriction;
  stressFriction: CandidateFriction;
  store: {
    upsertCandidateOrder(order: CandidateOrder): void;
    closeCandidateOrder(id: string, remainingBert: string, t: string, reason: string): void;
    upsertCandidateFill(fill: CandidateFillRecord): void;
    abandonCandidateHedgeBatch(batchId: string, t: string, reason: string): void;
    syncCandidateGatePeriods(gates: Array<{ gate: string; detailJson: string }>, t: string): void;
  };
  hedgeBatch: (side: Side, sizeBert: Decimal) => Promise<CandidateHedgeResult>;
}

type AllocationOrder = Pick<CandidateOrder,
  'candidateOrderId' | 'strategyFingerprint' | 'side' | 'distanceBps' | 'price' | 'referencePriceUsd' | 'referenceImpactBps'>;

interface Allocation {
  fillId: string;
  order: AllocationOrder;
  trade: PublicTrade;
  volume: Decimal;
  remainingAfter: Decimal;
}

interface PendingHedge {
  hedgeBatchId: string;
  side: Side;
  allocations: Allocation[];
  inFlight: boolean;
  createdAtMs: number;
  recoveredAfterRestart: boolean;
}

interface DriftState {
  pulled: boolean;
  metricsStableSinceMs: number | null;
}

interface HistoryEntry {
  atMs: number;
  references: Map<string, { sell: Decimal; buy: Decimal }>;
}

export interface AllInEdgeResult {
  grossEdgeBps: Decimal;
  fixedCostBps: Decimal;
  netEdgeBps: Decimal;
  passes: boolean;
}

/** Quote-time all-in edge, including the full fixed cost on this one order. */
export function calculateAllInEdge(
  side: Side,
  quotePrice: Decimal,
  executableReferencePrice: Decimal,
  sizeBert: Decimal,
  friction: CandidateFriction,
  minimumBps: number,
): AllInEdgeResult {
  const grossEdgeBps = side === 'buy'
    ? executableReferencePrice.div(quotePrice).minus(1).mul(10_000)
    : quotePrice.div(executableReferencePrice).minus(1).mul(10_000);
  const notional = quotePrice.mul(sizeBert);
  const fixedCostBps = notional.gt(0)
    ? new Decimal(friction.transactionCostUsd).div(notional).mul(10_000)
    : new Decimal(Infinity);
  const netEdgeBps = grossEdgeBps
    .minus(friction.makerFeeBps)
    .minus(friction.latencyPenaltyBps)
    .minus(friction.failedHedgeReserveBps)
    .minus(fixedCostBps);
  return { grossEdgeBps, fixedCostBps, netEdgeBps, passes: netEdgeBps.gte(minimumBps) };
}

/** Observer-only candidate ladder and fill simulator. It has no venue handles. */
export class CandidateFillEngine {
  private orders = new Map<string, CandidateOrder>();
  private seenTradeIds = new Set<number>();
  private pendingHedges: PendingHedge[] = [];
  private history: HistoryEntry[] = [];
  private lastSnapshotAtMs: number | null = null;
  private refreshFailed = false;
  private externalGates = new Map<string, string>();
  private orderSeq = 0;
  private batchSeq = 0;
  private fillSeq = 0;
  private drift: Record<Side, DriftState> = {
    buy: { pulled: false, metricsStableSinceMs: null },
    sell: { pulled: false, metricsStableSinceMs: null },
  };

  constructor(private opts: CandidateFillEngineOpts) {}

  recordRefreshFailure(): void { this.refreshFailed = true; }
  recordRefreshSuccess(): void { this.refreshFailed = false; }

  /** Runtime/provider gates are incorporated into the same auditable lifecycle. */
  setExternalGates(gates: Array<{ gate: string; detailJson: string }>): void {
    this.externalGates = new Map(gates.map(gate => [gate.gate, gate.detailJson]));
  }

  activeOrders(): CandidateOrder[] { return [...this.orders.values()].map(order => ({ ...order })); }
  hasPendingHedge(): boolean { return this.pendingHedges.length > 0; }

  /** Rehydrate fill batches whose executable hedge simulation was interrupted by restart. */
  restorePendingFills(fills: CandidatePendingFill[], now = new Date()): void {
    const groups = new Map<string, CandidatePendingFill[]>();
    for (const fill of fills) {
      const key = `${fill.hedgeBatchId}:${fill.side}`;
      const group = groups.get(key) ?? [];
      group.push(fill);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      const first = group[0];
      if (!first) continue;
      const createdAtMs = Math.min(...group.map(fill => Date.parse(fill.t)));
      if (now.getTime() - createdAtMs > this.opts.maxPendingHedgeAgeMs) {
        this.opts.store.abandonCandidateHedgeBatch(first.hedgeBatchId, now.toISOString(), 'restart_pending_expired');
        continue;
      }
      const allocations: Allocation[] = group.map(fill => ({
        fillId: fill.candidateFillId,
        order: {
          candidateOrderId: fill.candidateOrderId,
          strategyFingerprint: fill.strategyFingerprint,
          side: fill.side,
          distanceBps: fill.distanceBps,
          price: fill.fillPriceUsd,
          referencePriceUsd: fill.referencePriceUsd,
          referenceImpactBps: fill.referenceImpactBps,
        },
        trade: {
          tradeId: fill.krakenTradeId,
          side: null,
          price: new Decimal(fill.fillPriceUsd),
          volume: new Decimal(fill.volumeBert),
          t: new Date(fill.t),
        },
        volume: new Decimal(fill.volumeBert),
        remainingAfter: new Decimal(fill.orderRemainingBert),
      }));
      this.pendingHedges.push({
        hedgeBatchId: first.hedgeBatchId,
        side: first.side,
        allocations,
        inFlight: false,
        createdAtMs,
        recoveredAfterRestart: true,
      });
    }
  }

  updateQuotes(snapshot: CandidateEconomicSnapshot | null, now = new Date()): void {
    if (snapshot && snapshot.asOf.getTime() !== this.lastSnapshotAtMs) this.recordSnapshot(snapshot);
    const nowIso = now.toISOString();
    const gates = this.currentGates(snapshot, now);
    const globalReason = this.globalCloseReason(snapshot, now);
    const keep = new Set<string>();
    const closeReasons = new Map<string, string>();
    const exposure: Record<Side, Decimal> = { buy: new Decimal(0), sell: new Decimal(0) };

    for (const side of ['buy', 'sell'] as const) {
      for (const [rungIndex, rung] of this.opts.ladder.entries()) {
        const key = orderKey(side, rungIndex);
        let reason = globalReason;
        const reference = snapshot?.references.get(new Decimal(rung.sizeBert).toString());
        if (!reason && !reference) reason = 'gate_untrusted';
        if (!reason && reference && !routeTrusted(side, reference, this.opts.routeVsReserveMaxBps)) reason = 'route_gate';
        if (!reason && this.drift[side].pulled) reason = 'drift_pull';
        if (!reason && exposure[side].plus(rung.sizeBert).gt(this.opts.maxActivePerSideBert)) reason = 'exposure_gate';

        if (!reason && snapshot && reference) {
          const target = postOnlyPrice(side, ladderPrice(side, reference, rung.distanceBps), snapshot.book);
          const size = new Decimal(rung.sizeBert);
          const refPrice = side === 'buy' ? reference.executableSellPriceUsd : reference.executableBuyPriceUsd;
          const normal = calculateAllInEdge(side, target, refPrice, size, this.opts.normalFriction, this.opts.minAllInEdgeBps);
          const stress = calculateAllInEdge(side, target, refPrice, size, this.opts.stressFriction, this.opts.minAllInEdgeBps);
          if (!normal.passes) {
            reason = 'min_edge';
            gates.push({ gate: `min_edge_${side}_${rungIndex}`, detailJson: edgeGateDetail(normal, stress) });
          } else {
            exposure[side] = exposure[side].plus(size);
            keep.add(key);
            this.placeOrRefresh(key, rungIndex, rung, side, target, reference, normal, stress, snapshot, now);
          }
        }
        if (reason) closeReasons.set(key, reason);
      }
    }

    for (const [key, order] of [...this.orders]) {
      if (keep.has(key)) continue;
      this.opts.store.closeCandidateOrder(order.candidateOrderId, order.remainingBert, nowIso, closeReasons.get(key) ?? globalReason ?? 'gate_untrusted');
      this.orders.delete(key);
    }
    this.opts.store.syncCandidateGatePeriods(dedupeGates(gates), nowIso);
  }

  /**
   * Allocate every public trade once across the price-priority ladder. State is
   * cancelled synchronously before the simulated hedge promise is started.
   */
  onTradeBatch(trades: PublicTrade[], now = new Date()): Promise<void> {
    const allocations: Allocation[] = [];
    for (const trade of trades) {
      if (this.seenTradeIds.has(trade.tradeId)) continue;
      this.rememberTrade(trade.tradeId);
      if (trade.side === null) continue;
      const hitSide: Side = trade.side === 'sell' ? 'buy' : 'sell';
      let available = new Decimal(trade.volume);
      const eligible = [...this.orders.values()]
        .filter(order => order.side === hitSide && tradesThrough(trade, order))
        .sort(priceTimePriority);
      for (const order of eligible) {
        if (available.lte(0)) break;
        const queue = new Decimal(order.queueAheadRemainingBert);
        const queueConsumed = Decimal.min(queue, available);
        if (queueConsumed.gt(0)) {
          order.queueAheadRemainingBert = queue.minus(queueConsumed).toString();
          order.updatedAt = trade.t.toISOString();
          available = available.minus(queueConsumed);
          this.opts.store.upsertCandidateOrder(order);
        }
        if (available.lte(0)) break;
        const remaining = new Decimal(order.remainingBert);
        const fillVolume = Decimal.min(remaining, available);
        if (fillVolume.lte(0)) continue;
        const remainingAfter = remaining.minus(fillVolume);
        order.remainingBert = remainingAfter.toString();
        order.updatedAt = trade.t.toISOString();
        available = available.minus(fillVolume);
        allocations.push({
          fillId: `cf-${trade.tradeId}-${++this.fillSeq}`,
          order: { ...order },
          trade,
          volume: fillVolume,
          remainingAfter,
        });
        this.opts.store.upsertCandidateOrder(order);
      }
    }

    if (allocations.length === 0) return Promise.resolve();
    const closeAt = latestTradeTime(allocations).toISOString();
    for (const order of this.orders.values()) {
      const reason = new Decimal(order.remainingBert).eq(0) ? 'filled' : 'cancel_on_fill';
      this.opts.store.closeCandidateOrder(order.candidateOrderId, order.remainingBert, closeAt, reason);
    }
    this.orders.clear();

    const hedgeBatchId = `ch-${latestTradeTime(allocations).getTime()}-${++this.batchSeq}`;
    for (const side of ['buy', 'sell'] as const) {
      const sideAllocations = allocations.filter(allocation => allocation.order.side === side);
      if (sideAllocations.length === 0) continue;
      this.writeFills(hedgeBatchId, sideAllocations, null, false, null);
      this.pendingHedges.push({
        hedgeBatchId,
        side,
        allocations: sideAllocations,
        inFlight: false,
        createdAtMs: now.getTime(),
        recoveredAfterRestart: false,
      });
    }
    return this.retryPendingHedges(now);
  }

  async retryPendingHedges(now = new Date()): Promise<void> {
    for (const pending of [...this.pendingHedges]) {
      if (now.getTime() - pending.createdAtMs > this.opts.maxPendingHedgeAgeMs) {
        this.opts.store.abandonCandidateHedgeBatch(pending.hedgeBatchId, now.toISOString(), 'pending_hedge_expired');
        this.pendingHedges = this.pendingHedges.filter(item => item !== pending);
        continue;
      }
      if (pending.inFlight) continue;
      pending.inFlight = true;
      const total = pending.allocations.reduce((sum, allocation) => sum.plus(allocation.volume), new Decimal(0));
      try {
        const hedge = await this.opts.hedgeBatch(pending.side, total);
        // A hung attempt may have been terminally abandoned by a later tick.
        if (!this.pendingHedges.includes(pending)) continue;
        this.writeFills(pending.hedgeBatchId, pending.allocations, hedge, pending.recoveredAfterRestart, now);
        this.pendingHedges = this.pendingHedges.filter(item => item !== pending);
      } catch {
        pending.inFlight = false;
      }
    }
  }

  private placeOrRefresh(
    key: string,
    rungIndex: number,
    rung: CandidateLadderRung,
    side: Side,
    price: Decimal,
    reference: CandidateReference,
    normal: AllInEdgeResult,
    stress: AllInEdgeResult,
    snapshot: CandidateEconomicSnapshot,
    now: Date,
  ): void {
    const existing = this.orders.get(key);
    const priceDrift = existing
      ? price.minus(existing.price).abs().div(existing.price).mul(10_000)
      : new Decimal(Infinity);
    if (existing && priceDrift.lt(this.opts.repriceThresholdBps)) {
      existing.referencePriceUsd = referencePrice(side, reference).toString();
      existing.referenceImpactBps = referenceImpact(side, reference).toString();
      existing.expectedGrossEdgeBps = normal.grossEdgeBps.toString();
      existing.expectedNormalNetEdgeBps = normal.netEdgeBps.toString();
      existing.expectedStressNetEdgeBps = stress.netEdgeBps.toString();
      existing.economicSnapshotAt = snapshot.asOf.toISOString();
      existing.updatedAt = now.toISOString();
      this.opts.store.upsertCandidateOrder(existing);
      return;
    }
    if (existing) {
      this.opts.store.closeCandidateOrder(existing.candidateOrderId, existing.remainingBert, now.toISOString(), 'reprice');
    }
    const size = new Decimal(rung.sizeBert);
    const queue = queueAhead(snapshot.book, side, price);
    const order: CandidateOrder = {
      candidateOrderId: `candidate-${side}-${rungIndex}-${now.getTime()}-${++this.orderSeq}`,
      strategyFingerprint: this.opts.strategyFingerprint,
      rungIndex,
      side,
      distanceBps: new Decimal(rung.distanceBps).toString(),
      price: price.toString(),
      sizeBert: size.toString(),
      remainingBert: size.toString(),
      queueAheadAtPlacementBert: queue.toString(),
      queueAheadRemainingBert: queue.toString(),
      referencePriceUsd: referencePrice(side, reference).toString(),
      referenceImpactBps: referenceImpact(side, reference).toString(),
      expectedGrossEdgeBps: normal.grossEdgeBps.toString(),
      expectedNormalNetEdgeBps: normal.netEdgeBps.toString(),
      expectedStressNetEdgeBps: stress.netEdgeBps.toString(),
      economicSnapshotAt: snapshot.asOf.toISOString(),
      placedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.orders.set(key, order);
    this.opts.store.upsertCandidateOrder(order);
  }

  private writeFills(
    batchId: string,
    allocations: Allocation[],
    hedge: CandidateHedgeResult | null,
    recoveredAfterRestart: boolean,
    resolvedAt: Date | null,
  ): void {
    const totalNotional = allocations.reduce(
      (sum, allocation) => sum.plus(new Decimal(allocation.order.price).mul(allocation.volume)),
      new Decimal(0),
    );
    for (const allocation of allocations) {
      const fillPrice = new Decimal(allocation.order.price);
      const fillNotional = fillPrice.mul(allocation.volume);
      const txShare = totalNotional.gt(0) ? fillNotional.div(totalNotional) : new Decimal(0);
      const dexPrice = hedge?.dexPriceUsd ?? new Decimal(allocation.order.referencePriceUsd);
      const impact = hedge?.dexImpactBps ?? new Decimal(allocation.order.referenceImpactBps);
      const normal = realizedEconomics(allocation.order.side, fillPrice, allocation.volume, dexPrice, this.opts.normalFriction, txShare);
      const stress = realizedEconomics(allocation.order.side, fillPrice, allocation.volume, dexPrice, this.opts.stressFriction, txShare);
      this.opts.store.upsertCandidateFill({
        candidateFillId: allocation.fillId,
        strategyFingerprint: allocation.order.strategyFingerprint,
        candidateOrderId: allocation.order.candidateOrderId,
        krakenTradeId: allocation.trade.tradeId,
        hedgeBatchId: batchId,
        side: allocation.order.side,
        distanceBps: allocation.order.distanceBps,
        fillPriceUsd: fillPrice.toString(),
        volumeBert: allocation.volume.toString(),
        orderRemainingBert: allocation.remainingAfter.toString(),
        dexHedgePriceUsd: dexPrice.toString(),
        dexImpactBps: impact.toString(),
        grossPnlUsd: normal.gross.toString(),
        normalMakerFeeUsd: normal.maker.toString(),
        normalLatencyCostUsd: normal.latency.toString(),
        normalFailureReserveUsd: normal.failure.toString(),
        normalTransactionCostUsd: normal.transaction.toString(),
        normalNetPnlUsd: normal.net.toString(),
        stressMakerFeeUsd: stress.maker.toString(),
        stressLatencyCostUsd: stress.latency.toString(),
        stressFailureReserveUsd: stress.failure.toString(),
        stressTransactionCostUsd: stress.transaction.toString(),
        stressNetPnlUsd: stress.net.toString(),
        hedgeStatus: hedge ? 'simulated' : 'pending',
        economicsSource: hedge
          ? recoveredAfterRestart ? 'restart_recovered_executable' : 'fill_time_executable'
          : 'placement_reference',
        hedgeResolvedAt: hedge ? (resolvedAt ?? new Date()).toISOString() : null,
        hedgeTerminalReason: null,
        t: allocation.trade.t.toISOString(),
      });
    }
  }

  private globalCloseReason(snapshot: CandidateEconomicSnapshot | null, now: Date): string | null {
    const externalGate = this.externalGates.keys().next().value as string | undefined;
    if (externalGate) return externalGate;
    if (!snapshot || now.getTime() - snapshot.asOf.getTime() > this.opts.maxQuoteAgeMs) return 'ttl_stale';
    if (this.pendingHedges.length > 0) return 'hedge_pending';
    if (now.getTime() - snapshot.book.t.getTime() > this.opts.maxBookAgeSec * 1000) return 'gate_untrusted';
    if (snapshot.crossVenueDivergenceBps.gt(this.opts.crossVenueMaxBps)) return 'gate_untrusted';
    return null;
  }

  private currentGates(snapshot: CandidateEconomicSnapshot | null, now: Date): Array<{ gate: string; detailJson: string }> {
    const gates: Array<{ gate: string; detailJson: string }> = [...this.externalGates]
      .map(([gate, detailJson]) => ({ gate, detailJson }));
    if (!snapshot || now.getTime() - snapshot.asOf.getTime() > this.opts.maxQuoteAgeMs) {
      gates.push({ gate: 'ttl_stale', detailJson: JSON.stringify({ maxAgeMs: this.opts.maxQuoteAgeMs }) });
    }
    if (this.refreshFailed) gates.push({ gate: 'refresh_failed', detailJson: '{}' });
    if (this.pendingHedges.length > 0) gates.push({ gate: 'hedge_pending', detailJson: '{}' });
    if (snapshot) {
      const bookAgeMs = Math.max(0, now.getTime() - snapshot.book.t.getTime());
      if (bookAgeMs > this.opts.maxBookAgeSec * 1000) {
        gates.push({ gate: 'book_stale', detailJson: JSON.stringify({ bookAgeMs }) });
      }
      if (snapshot.crossVenueDivergenceBps.gt(this.opts.crossVenueMaxBps)) {
        gates.push({ gate: 'cross_venue', detailJson: JSON.stringify({ divergenceBps: snapshot.crossVenueDivergenceBps.toString() }) });
      }
      for (const reference of snapshot.references.values()) {
        if (reference.sellRouteDeviationBps.gt(this.opts.routeVsReserveMaxBps)) {
          gates.push({ gate: `route_gate_buy_${reference.sizeBert.toString()}`, detailJson: JSON.stringify({ deviationBps: reference.sellRouteDeviationBps.toString() }) });
        }
        if (reference.buyRouteDeviationBps.gt(this.opts.routeVsReserveMaxBps)) {
          gates.push({ gate: `route_gate_sell_${reference.sizeBert.toString()}`, detailJson: JSON.stringify({ deviationBps: reference.buyRouteDeviationBps.toString() }) });
        }
      }
    }
    for (const side of ['buy', 'sell'] as const) {
      if (this.drift[side].pulled) gates.push({ gate: `drift_pull_${side}`, detailJson: '{}' });
    }
    return gates;
  }

  private recordSnapshot(snapshot: CandidateEconomicSnapshot): void {
    const atMs = snapshot.asOf.getTime();
    if (this.lastSnapshotAtMs !== null && atMs <= this.lastSnapshotAtMs) return;
    const references = new Map<string, { sell: Decimal; buy: Decimal }>();
    for (const [size, reference] of snapshot.references) {
      references.set(size, { sell: reference.executableSellPriceUsd, buy: reference.executableBuyPriceUsd });
    }
    this.history.push({ atMs, references });
    this.history = this.history.filter(entry => entry.atMs >= atMs - 120_000);
    for (const side of ['buy', 'sell'] as const) {
      const state = this.drift[side];
      const triggered = this.driftTriggered(side, this.history[this.history.length - 1]!);
      if (!state.pulled && triggered) {
        state.pulled = true;
        state.metricsStableSinceMs = null;
      } else if (state.pulled) {
        if (triggered) {
          state.metricsStableSinceMs = null;
        } else {
          state.metricsStableSinceMs ??= atMs;
        }
        if (state.metricsStableSinceMs !== null
          && atMs - state.metricsStableSinceMs >= this.opts.driftResumeStableSec * 1000) {
          state.pulled = false;
          state.metricsStableSinceMs = null;
        }
      }
    }
    this.lastSnapshotAtMs = atMs;
  }

  private driftTriggered(side: Side, current: HistoryEntry): boolean {
    return this.lookbackTriggered(side, current, 5000, this.opts.drift5sBps)
      || this.lookbackTriggered(side, current, 30_000, this.opts.drift30sBps);
  }

  private lookbackTriggered(side: Side, current: HistoryEntry, windowMs: number, thresholdBps: number): boolean {
    const target = current.atMs - windowMs;
    let baseline: HistoryEntry | undefined;
    for (const entry of this.history) {
      if (entry.atMs <= target) baseline = entry;
      else break;
    }
    if (!baseline) return false;
    for (const [size, currentRef] of current.references) {
      const oldRef = baseline.references.get(size);
      if (!oldRef) continue;
      const adverse = side === 'buy'
        ? oldRef.sell.minus(currentRef.sell).div(oldRef.sell).mul(10_000)
        : currentRef.buy.minus(oldRef.buy).div(oldRef.buy).mul(10_000);
      if (adverse.gte(thresholdBps)) return true;
    }
    return false;
  }

  private rememberTrade(tradeId: number): void {
    this.seenTradeIds.add(tradeId);
    if (this.seenTradeIds.size > 20_000) this.seenTradeIds = new Set([...this.seenTradeIds].slice(-10_000));
  }
}

function ladderPrice(side: Side, reference: CandidateReference, distanceBps: number): Decimal {
  const distance = new Decimal(distanceBps).div(10_000);
  return side === 'buy'
    ? reference.executableSellPriceUsd.div(new Decimal(1).plus(distance))
    : reference.executableBuyPriceUsd.mul(new Decimal(1).plus(distance));
}

function postOnlyPrice(side: Side, target: Decimal, book: BookSnapshot): Decimal {
  const tick = new Decimal('0.000001');
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (!bid || !ask) return target;
  return side === 'buy' ? Decimal.min(target, ask.minus(tick)) : Decimal.max(target, bid.plus(tick));
}

function queueAhead(book: BookSnapshot, side: Side, price: Decimal): Decimal {
  const levels = side === 'buy' ? book.bids : book.asks;
  return levels
    .filter(level => side === 'buy' ? level.price.gte(price) : level.price.lte(price))
    .reduce((total, level) => total.plus(level.volume), new Decimal(0));
}

function referencePrice(side: Side, reference: CandidateReference): Decimal {
  return side === 'buy' ? reference.executableSellPriceUsd : reference.executableBuyPriceUsd;
}

function referenceImpact(side: Side, reference: CandidateReference): Decimal {
  return side === 'buy' ? reference.sellImpactBps : reference.buyImpactBps;
}

function routeTrusted(side: Side, reference: CandidateReference, maxBps: number): boolean {
  return (side === 'buy' ? reference.sellRouteDeviationBps : reference.buyRouteDeviationBps).lte(maxBps);
}

function orderKey(side: Side, rungIndex: number): string { return `${side}-${rungIndex}`; }

function tradesThrough(trade: PublicTrade, order: CandidateOrder): boolean {
  const price = new Decimal(order.price);
  return order.side === 'buy' ? trade.price.lte(price) : trade.price.gte(price);
}

function priceTimePriority(a: CandidateOrder, b: CandidateOrder): number {
  const priceCmp = new Decimal(a.price).cmp(b.price);
  if (priceCmp !== 0) return a.side === 'buy' ? -priceCmp : priceCmp;
  return a.placedAt.localeCompare(b.placedAt);
}

function latestTradeTime(allocations: Allocation[]): Date {
  return new Date(Math.max(...allocations.map(allocation => allocation.trade.t.getTime())));
}

function edgeGateDetail(normal: AllInEdgeResult, stress: AllInEdgeResult): string {
  return JSON.stringify({ normalNetEdgeBps: normal.netEdgeBps.toString(), stressNetEdgeBps: stress.netEdgeBps.toString() });
}

function dedupeGates(gates: Array<{ gate: string; detailJson: string }>): Array<{ gate: string; detailJson: string }> {
  return [...new Map(gates.map(gate => [gate.gate, gate])).values()];
}

function realizedEconomics(
  side: Side,
  fillPrice: Decimal,
  volume: Decimal,
  dexPrice: Decimal,
  friction: CandidateFriction,
  txShare: Decimal,
): { gross: Decimal; maker: Decimal; latency: Decimal; failure: Decimal; transaction: Decimal; net: Decimal } {
  const gross = side === 'buy' ? dexPrice.minus(fillPrice).mul(volume) : fillPrice.minus(dexPrice).mul(volume);
  const maker = fillPrice.mul(volume).mul(friction.makerFeeBps).div(10_000);
  const latency = dexPrice.mul(volume).mul(friction.latencyPenaltyBps).div(10_000);
  const failure = dexPrice.mul(volume).mul(friction.failedHedgeReserveBps).div(10_000);
  const transaction = new Decimal(friction.transactionCostUsd).mul(txShare);
  return { gross, maker, latency, failure, transaction, net: gross.minus(maker).minus(latency).minus(failure).minus(transaction) };
}
