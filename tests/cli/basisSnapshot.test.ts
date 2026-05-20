import { describe, it, expect } from 'vitest';
import { runBasisSnapshot } from '../../src/cli/basisSnapshot.js';
import { StateStore } from '../../src/stateStore.js';

describe('runBasisSnapshot', () => {
  it('produces a CSV with header and one row per sample', () => {
    const store = new StateStore(':memory:');
    store.insertBasisSample({
      t: '2026-05-20T00:00:00Z', raydiumMidUsd: '0.0177', krakenBid: '0.0176',
      krakenAsk: '0.0178', solUsd: '86.12', wouldHaveActed: false,
    });
    const lines: string[] = [];
    runBasisSnapshot(store, '2026-05-19T00:00:00Z', (s: string) => lines.push(s));
    expect(lines[0]).toMatch(/^t,raydiumMidUsd,/);
    expect(lines[1]).toMatch(/0\.0177/);
  });
});
