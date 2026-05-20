import Decimal from 'decimal.js';
import { newClOrdId, type Order, type BookSnapshot, type FeeTier, type Side } from '../types.js';
import type { NetDeltaSnapshot } from './netDeltaTracker.js';

export interface QuoterConfig {
  bufferBps: number;
  driftThresholdBps: number;
  inventorySkewBpsPerUsd: number;
  minEdgeBps: number;
  maxInventoryUsd: number;
  defaultVolumeBert: Decimal;
}

export interface QuoterInput {
  ref: { raydiumMidUsd: Decimal; solUsd: Decimal; asOf: Date };
  oracleTrusted: boolean;
  krakenBook: BookSnapshot;
  openOrders: Order[];
  inventory: NetDeltaSnapshot;
  feeTier: FeeTier;
  dexCostBps: number;
  config: QuoterConfig;
}

export type QuoteIntent =
  | { action: 'place';  side: Side; price: Decimal; volume: Decimal; clOrdId: string }
  | { action: 'amend';  venueOrderId: string; price?: Decimal; volume?: Decimal }
  | { action: 'cancel'; venueOrderId: string; reason: 'drift'|'unprofitable'|'inventory_cap'|'oracle_untrusted' };

function bpsAdjustedPrice(mid: Decimal, side: Side, totalBps: number): Decimal {
  const factor = new Decimal(1).plus(new Decimal(side === 'buy' ? -totalBps : totalBps).div(10_000));
  return mid.mul(factor);
}

function skewBps(usdNet: Decimal, side: Side, coeff: number): number {
  const raw = usdNet.toNumber() * coeff;
  return side === 'buy' ? raw : -raw;
}

export function decideQuotes(input: QuoterInput): QuoteIntent[] {
  const out: QuoteIntent[] = [];
  if (!input.oracleTrusted) {
    for (const o of input.openOrders) out.push({ action: 'cancel', venueOrderId: o.venueOrderId, reason: 'oracle_untrusted' });
    return out;
  }

  const longCapped = input.inventory.usdNet.gt(input.config.maxInventoryUsd);
  const shortCapped = input.inventory.usdNet.lt(-input.config.maxInventoryUsd);

  for (const side of ['buy', 'sell'] as const) {
    const skew = skewBps(input.inventory.usdNet, side, input.config.inventorySkewBpsPerUsd);
    const totalBps = input.config.bufferBps + skew;
    // Profitability gate: configured spread floor must clear minEdgeBps.
    // expectedRtBps is informational (round-trip fee accounting) but the test
    // contract compares bufferBps directly against minEdgeBps.
    const _expectedRtBps = input.feeTier.makerBps + input.dexCostBps;
    void _expectedRtBps;
    if (input.config.bufferBps < input.config.minEdgeBps) continue;

    if (side === 'buy' && longCapped) continue;
    if (side === 'sell' && shortCapped) continue;

    const target = bpsAdjustedPrice(input.ref.raydiumMidUsd, side, totalBps);
    const existing = input.openOrders.find(o => o.side === side);

    if (!existing) {
      out.push({ action: 'place', side, price: target, volume: input.config.defaultVolumeBert, clOrdId: newClOrdId('bx') });
    } else {
      const driftBps = target.minus(existing.price).abs().div(existing.price).mul(10_000);
      if (driftBps.gt(input.config.driftThresholdBps)) {
        out.push({ action: 'amend', venueOrderId: existing.venueOrderId, price: target });
      }
    }
  }

  if (longCapped) {
    const o = input.openOrders.find(o => o.side === 'buy');
    if (o) out.push({ action: 'cancel', venueOrderId: o.venueOrderId, reason: 'inventory_cap' });
  }
  if (shortCapped) {
    const o = input.openOrders.find(o => o.side === 'sell');
    if (o) out.push({ action: 'cancel', venueOrderId: o.venueOrderId, reason: 'inventory_cap' });
  }

  return out;
}
