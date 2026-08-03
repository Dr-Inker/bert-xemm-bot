import type { KillResult, KillAction } from './conditions.js';
import type { Logger } from '../logger.js';

export interface WatchdogStore {
  setFlag(key: string, value: string): void;
  insertKillEvent(row: { t: string; conditionId: number; snapshotJson: string; actionTaken: KillAction }): void;
  /** In-process degraded latch, used when the durable setFlag cannot be trusted to land. */
  latchDegraded?(): void;
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
  logger?: Pick<Logger, 'error'>;
}

export class KillSwitchWatchdog {
  constructor(private opts: WatchdogOpts) {}

  /**
   * Runs one kill step best-effort. A failing step must never prevent the remaining
   * steps from running, so every failure is logged and swallowed here.
   */
  private async attempt(step: string, fn: () => void | Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // The logger is itself a fallible dependency (closed transport, full pipe). If it
      // threw here it would abort every remaining safety step, so it gets its own guard.
      try {
        this.opts.logger?.error({ err, step }, 'watchdog kill step failed; continuing');
      } catch { /* nothing left to log with */ }
    }
  }

  async tick(): Promise<KillResult[]> {
    const results = await this.opts.evaluate();
    const tripped = results.filter(r => r.tripped);
    if (tripped.length === 0) return [];

    // The in-memory latch goes first and outside attempt(): it touches neither disk nor
    // network, so it is the one step that essentially cannot fail, and it is what the
    // quoter gate ORs against when the durable write below does not land.
    try { this.opts.store.latchDegraded?.(); } catch { /* must never block the kill path */ }

    // Order matters: latch local state and raise the alarm FIRST, then reach out to the
    // venue. cancelAll is the step most likely to fail (network, venue 5xx) and a failure
    // there must not cost us the degraded latch, the audit row, or the page.
    await this.attempt('setFlag', () => this.opts.store.setFlag('degraded', '1'));

    for (let i = 0; i < tripped.length; i++) {
      const r = tripped[i]!;
      await this.attempt('insertKillEvent', () => this.opts.store.insertKillEvent({
        t: new Date().toISOString(),
        conditionId: i,
        snapshotJson: JSON.stringify(r),
        actionTaken: r.action,
      }));
    }

    await this.attempt('page', () => this.opts.notifier.page(
      `KILL: ${tripped.map(r => r.reason).filter(Boolean).join(' | ')}`,
    ));

    await this.attempt('cancelAll', () => this.opts.cex.cancelAll());

    return tripped;
  }
}
