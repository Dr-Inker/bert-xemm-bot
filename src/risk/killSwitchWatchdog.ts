import type { KillResult, KillAction } from './conditions.js';

export interface WatchdogStore {
  setFlag(key: string, value: string): void;
  insertKillEvent(row: { t: string; conditionId: number; snapshotJson: string; actionTaken: KillAction }): void;
}

export interface WatchdogVenue {
  cancelAll(): Promise<{ cancelled: number }>;
}

export interface WatchdogOpts {
  store: WatchdogStore;
  cex: WatchdogVenue;
  notifier: { page(msg: string): void; warn(msg: string): void };
  evaluate: () => Promise<KillResult[]>;
}

export class KillSwitchWatchdog {
  constructor(private opts: WatchdogOpts) {}
  async tick(): Promise<KillResult[]> {
    const results = await this.opts.evaluate();
    const tripped = results.filter(r => r.tripped);
    if (tripped.length === 0) return [];
    await this.opts.cex.cancelAll();
    this.opts.store.setFlag('degraded', '1');
    for (let i = 0; i < tripped.length; i++) {
      this.opts.store.insertKillEvent({
        t: new Date().toISOString(),
        conditionId: i,
        snapshotJson: JSON.stringify(tripped[i]),
        actionTaken: tripped[i]!.action,
      });
    }
    this.opts.notifier.page(`KILL: ${tripped.map(r => r.reason).filter(Boolean).join(' | ')}`);
    return tripped;
  }
}
