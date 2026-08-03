import Decimal from 'decimal.js';

export interface NetDeltaInput {
  kraken: { base: Decimal; quote: Decimal };
  dex: { bert: Decimal; sol: Decimal };
  /**
   * Signed net BERT *outflow* of hedges currently in flight:
   *   positive → a DEX sell-hedge is in flight, BERT is on its way out
   *   negative → a DEX buy-hedge is in flight, BERT is on its way in
   * In-flight hedges are conservatively counted as already settled, so the value is
   * subtracted from the observed balances (a negative outflow therefore adds BERT).
   */
  inFlightHedgesBert: Decimal;
  midUsd: Decimal;
}

export interface NetDeltaSnapshot {
  bertNet: Decimal;
  usdNet: Decimal;
  asOf: Date;
}

export class NetDeltaTracker {
  snapshot(i: NetDeltaInput): NetDeltaSnapshot {
    const bertNet = i.kraken.base.plus(i.dex.bert).minus(i.inFlightHedgesBert);
    const usdNet = bertNet.mul(i.midUsd);
    return { bertNet, usdNet, asOf: new Date() };
  }
}
