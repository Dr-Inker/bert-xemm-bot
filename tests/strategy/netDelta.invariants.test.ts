import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import Decimal from 'decimal.js';
import { NetDeltaTracker } from '../../src/strategy/netDeltaTracker.js';

const positiveDecimalArb = fc.float({ min: 0, max: 1e6, noNaN: true }).map(n => new Decimal(n.toFixed(6)));

describe('NetDeltaTracker invariant', () => {
  it('bertNet always equals kraken.base + dex.bert - inFlightHedges', () => {
    fc.assert(fc.property(
      positiveDecimalArb, positiveDecimalArb, positiveDecimalArb, positiveDecimalArb, positiveDecimalArb,
      (krakenBase, krakenQuote, dexBert, dexSol, inFlight) => {
        const tracker = new NetDeltaTracker();
        const snap = tracker.snapshot({
          kraken: { base: krakenBase, quote: krakenQuote },
          dex: { bert: dexBert, sol: dexSol },
          inFlightHedgesBert: inFlight,
          midUsd: new Decimal('0.0177'),
        });
        const expected = krakenBase.plus(dexBert).minus(inFlight);
        return snap.bertNet.equals(expected);
      },
    ), { numRuns: 200 });
  });
});
