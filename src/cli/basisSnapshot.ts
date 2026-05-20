import type { StateStore } from '../stateStore.js';
export function runBasisSnapshot(store: StateStore, sinceIso: string, write: (line: string) => void = (s) => process.stdout.write(s + '\n')): void {
  const rows = store.basisSamplesSince(sinceIso);
  write('t,raydiumMidUsd,krakenBid,krakenAsk,solUsd,wouldHaveActed');
  for (const r of rows) write(`${r.t},${r.raydiumMidUsd},${r.krakenBid},${r.krakenAsk},${r.solUsd},${r.wouldHaveActed ? 1 : 0}`);
}
