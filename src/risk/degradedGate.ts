export interface FlagStore {
  getFlag(key: string): string | null;
  setFlag(key: string, value: string): void;
}

export interface DegradedGate extends FlagStore {
  /** Arms the in-process latch. Cannot touch disk or network, so it cannot realistically fail. */
  latchDegraded(): void;
}

/**
 * Wraps the durable flag store with an in-process degraded latch.
 *
 * The kill path's only durable record of "stop quoting" is a sqlite write, and that write
 * can fail (disk full, locked db) while reads keep succeeding — leaving the quoter happily
 * quoting after the kill switch fired. The in-memory latch closes that window: once armed,
 * reads of `degraded` report '1' regardless of what the durable store says.
 *
 * The latch is deliberately sticky for the lifetime of the process. `cli resume` clears the
 * persisted flag, but a bot that has already tripped must be restarted to quote again —
 * which is the conservative reading of the strictest kill action, cancel_all_refuse_resume.
 */
export function createDegradedGate(store: FlagStore): DegradedGate {
  let memoryDegraded = false;
  return {
    latchDegraded(): void { memoryDegraded = true; },
    getFlag(key: string): string | null {
      if (key === 'degraded' && memoryDegraded) return '1';
      return store.getFlag(key);
    },
    setFlag(key: string, value: string): void {
      // Arm the latch before attempting the durable write, so a throwing write still halts us.
      if (key === 'degraded' && value === '1') memoryDegraded = true;
      store.setFlag(key, value);
    },
  };
}
