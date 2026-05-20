import Decimal from 'decimal.js';

export interface NetDeltaInput {
  kraken: { base: Decimal; quote: Decimal };
  dex: { bert: Decimal; sol: Decimal };
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
