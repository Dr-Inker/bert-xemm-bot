/**
 * Recovery sweep for hedge rows stuck in a non-terminal status.
 *
 * The hedge path drives its own row to a terminal status when it fails, but that write is
 * itself fallible — if the store was the thing that broke, a row can survive at
 * intent_queued/swap_quoted/tx_submitted/failed_will_retry indefinitely. Such a row is
 * counted by sumInFlightHedgesBert() as though the hedge had settled, so the tracker
 * reports a flat book while the Kraken leg is genuinely exposed.
 *
 * This bounds how long that state can lie: anything older than STALE_HEDGE_MAX_AGE_MS is
 * driven to failed_dead_letter and paged. It preserves the conservative "in-flight counts
 * as settled" convention for genuinely recent hedges, which do still land.
 */

/** A hedge older than this cannot plausibly still be in flight — Solana settles in seconds. */
export const STALE_HEDGE_MAX_AGE_MS = 5 * 60_000;

export interface StaleHedgeRow {
  hedgeId: string;
  bertNotional: string | null;
  tIntent: string;
  status: string;
}

export interface HedgeSweepStore {
  listStaleInFlightHedges(cutoffIso: string): StaleHedgeRow[];
  markHedgeFailed(hedgeId: string, status: string): void;
}

export interface HedgeSweepOpts {
  store: HedgeSweepStore;
  notifier: { page(msg: string): void };
  maxAgeMs?: number;
  now?: Date;
  logger?: { error(obj: unknown, msg: string): void };
}

/**
 * Returns the number of rows successfully terminalised. Never throws: this runs on a timer
 * and at startup, and a sweep that crashes the process would be worse than a stale row.
 */
export function sweepStaleHedges(opts: HedgeSweepOpts): number {
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - (opts.maxAgeMs ?? STALE_HEDGE_MAX_AGE_MS)).toISOString();

  let rows: StaleHedgeRow[];
  try {
    rows = opts.store.listStaleInFlightHedges(cutoff);
  } catch (err) {
    try { opts.logger?.error({ err }, 'stale hedge sweep: could not list rows'); } catch { /* ignore */ }
    return 0;
  }

  let swept = 0;
  for (const r of rows) {
    try {
      opts.store.markHedgeFailed(r.hedgeId, 'failed_dead_letter');
      swept += 1;
      opts.notifier.page(
        `stale hedge ${r.hedgeId} (${r.status} since ${r.tIntent}) force-dead-lettered by sweep; ` +
        `${r.bertNotional ?? '0'} BERT may be unhedged — verify on chain`,
      );
    } catch (err) {
      // One bad row must not stop the rest.
      try { opts.logger?.error({ err, hedgeId: r.hedgeId }, 'stale hedge sweep: row failed'); } catch { /* ignore */ }
    }
  }
  return swept;
}
