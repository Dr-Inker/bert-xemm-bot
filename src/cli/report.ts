import type { StateStore } from '../stateStore.js';
export function runReport(store: StateStore, sinceIso: string): void {
  console.log(JSON.stringify({
    since: sinceIso,
    fills: store.countFillsSince(sinceIso),
    basisSamples: store.basisSamplesSince(sinceIso).length,
    degraded: store.getFlag('degraded') === '1',
  }, null, 2));
}
