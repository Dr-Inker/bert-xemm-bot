import type { KillResult, KillAction } from './conditions.js';

export interface WatchdogStore {
  setFlag(key: string, value: string): void;
  insertKillEvent(row: { t: string; conditionId: number; snapshotJson: string; actionTaken: KillAction }): void;
}

export interface WatchdogVenue {
  cancelAll(): Promise<{ cancelled: number }>;
}

/** Reason stamped on the synthetic kill result produced when evaluation itself fails. */
export const WATCHDOG_EVALUATE_ERROR_REASON = 'watchdog_evaluate_error';

/**
 * Strictest available action: cancel every resting order, latch degraded, page, and
 * refuse an automatic resume until a human clears the flag.
 */
export const WATCHDOG_EVALUATE_ERROR_ACTION: KillAction = 'cancel_all_refuse_resume';

/**
 * Wraps a condition-evaluation body so that a thrown error fails CLOSED.
 *
 * The body pushes its KillResults into the supplied array; if it throws part-way through,
 * whatever it managed to evaluate is kept AND a tripped `watchdog_evaluate_error` result is
 * appended, so a crashing evaluator trips the kill switch instead of silently disabling it.
 */
export function failClosedEvaluate(
  body: (out: KillResult[]) => Promise<void>,
  onError: (err: unknown) => void,
): () => Promise<KillResult[]> {
  return async (): Promise<KillResult[]> => {
    const out: KillResult[] = [];
    try {
      await body(out);
    } catch (err) {
      onError(err);
      out.push({
        tripped: true,
        reason: WATCHDOG_EVALUATE_ERROR_REASON,
        action: WATCHDOG_EVALUATE_ERROR_ACTION,
      });
    }
    return out;
  };
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
