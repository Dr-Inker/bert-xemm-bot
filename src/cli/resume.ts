import type { StateStore } from '../stateStore.js';
export function runResume(store: Pick<StateStore, 'setFlag'>): void {
  store.setFlag('degraded', '0');
  store.setFlag('emergency_unwind_complete', '0');
  console.log('resumed (degraded=0, emergency_unwind_complete=0)');
}
