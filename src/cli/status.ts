import type { StateStore } from '../stateStore.js';
export interface StatusReadModel {
  degraded: string | null;
  openOrderCount: number;
  recentBasisCount: number;
  lastFillT: string | null;
}
export function runStatus(_store: StateStore, read: () => StatusReadModel): void {
  const s = read();
  console.log(JSON.stringify({
    degraded: s.degraded === '1',
    openOrders: s.openOrderCount,
    basisSamplesLastHour: s.recentBasisCount,
    lastFillAt: s.lastFillT,
  }, null, 2));
}
