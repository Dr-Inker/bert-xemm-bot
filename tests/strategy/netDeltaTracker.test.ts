import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { NetDeltaTracker } from '../../src/strategy/netDeltaTracker.js';

describe('NetDeltaTracker', () => {
  it('sums Kraken BERT + DEX BERT for raw delta', () => {
    const t = new NetDeltaTracker();
    const snap = t.snapshot({
      kraken: { base: new Decimal('1000'), quote: new Decimal('500') },
      dex:    { bert:  new Decimal('2000'), sol:   new Decimal('1.5') },
      inFlightHedgesBert: new Decimal('0'),
      midUsd: new Decimal('0.0177'),
    });
    expect(snap.bertNet.toString()).toBe('3000');
    expect(parseFloat(snap.usdNet.toString())).toBeCloseTo(53.1, 2);
  });

  it('subtracts in-flight outbound hedges from BERT (sell-hedge of fill)', () => {
    const t = new NetDeltaTracker();
    const snap = t.snapshot({
      kraken: { base: new Decimal('1000'), quote: new Decimal('0') },
      dex:    { bert:  new Decimal('2000'), sol:   new Decimal('0') },
      inFlightHedgesBert: new Decimal('500'),
      midUsd: new Decimal('0.0177'),
    });
    expect(snap.bertNet.toString()).toBe('2500');
  });

  it('in-flight DEX sell-hedge (positive outflow) reduces bertNet', () => {
    const t = new NetDeltaTracker();
    const snap = t.snapshot({
      kraken: { base: new Decimal('1000'), quote: new Decimal('0') },
      dex:    { bert:  new Decimal('2000'), sol:   new Decimal('0') },
      // Kraken buy filled 500 BERT → we sell 500 BERT on the DEX; BERT is leaving.
      inFlightHedgesBert: new Decimal('500'),
      midUsd: new Decimal('0.0177'),
    });
    expect(snap.bertNet.toString()).toBe('2500');
  });

  it('in-flight DEX buy-hedge (negative outflow) increases bertNet', () => {
    const t = new NetDeltaTracker();
    const snap = t.snapshot({
      kraken: { base: new Decimal('1000'), quote: new Decimal('0') },
      dex:    { bert:  new Decimal('2000'), sol:   new Decimal('0') },
      // Kraken sell filled 500 BERT → we buy 500 BERT back on the DEX; BERT is arriving.
      inFlightHedgesBert: new Decimal('-500'),
      midUsd: new Decimal('0.0177'),
    });
    expect(snap.bertNet.toString()).toBe('3500');
  });
});
