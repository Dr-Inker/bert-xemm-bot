import type { StateStore } from '../stateStore.js';
export function runPause(store: Pick<StateStore, 'setFlag'>): void {
  store.setFlag('degraded', '1');
  console.log('paused (degraded=1)');
}
