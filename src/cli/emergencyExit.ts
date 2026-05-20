import type Decimal from 'decimal.js';
import { runEmergencyUnwind } from '../risk/emergencyUnwind.js';
import type { HedgeVenue } from '../venues/hedgeVenue.js';
import type { DexVenue } from '../venues/dexVenue.js';
import type { StateStore } from '../stateStore.js';

export async function runEmergencyExitCli(cex: HedgeVenue, dex: DexVenue, store: StateStore, notifier: { page(m: string): void }, minOrderBert: Decimal): Promise<void> {
  await runEmergencyUnwind({ cex, dex, notifier, store, minOrderBert });
}
