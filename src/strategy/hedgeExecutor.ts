import Decimal from 'decimal.js';
import type { Fill, Side } from '../types.js';
import type { DexVenue, SwapQuote } from '../venues/dexVenue.js';

export interface HedgeRow {
  hedgeId: string;
  triggeringFillId: string;
  status: 'intent_queued'|'swap_quoted'|'tx_submitted'|'confirmed'|'failed_will_retry'|'failed_dead_letter'|'slippage_aborted'|'cancelled_by_killswitch';
  jupiterQuote: string | null;
  txSig: string | null;
  slippageRealized: string | null;
  /** Signed BERT outflow of this hedge: positive = DEX sell-hedge, negative = DEX buy-hedge. */
  bertNotional: string;
  tIntent: string;
  tConfirmed: string | null;
}

export interface HedgeStore {
  writeHedge(row: HedgeRow): Promise<void>;
  /** Signed net BERT outflow of all non-terminal hedges (positive = BERT leaving us). */
  readInFlight(): Promise<Decimal>;
  markConfirmed(hedgeId: string, txSig: string, slippageRealized: string): Promise<void>;
}

export type TxStatusFn = (sig: string) => Promise<'pending'|'confirmed'|'failed'>;

export interface HedgeExecutorOpts {
  dex: DexVenue;
  store: HedgeStore;
  notifier: { page(msg: string): void };
  maxDexSlippageBps: number;
  jitoTipLamports: number;
  txStatus?: TxStatusFn;             // production: queries Solana RPC. Tests inject a mock.
  pollIntervalMs?: number;           // default 2000
  pollTimeoutMs?: number;            // default 30_000
  maxRetries?: number;               // default 3
}

let _hedgeSeq = 0;
const nextHedgeId = (): string => `h-${Date.now().toString(36)}-${(++_hedgeSeq).toString(36)}`;

export class HedgeExecutor {
  constructor(private opts: HedgeExecutorOpts) {}

  private hedgeDir(fillSide: Side): { input: 'BERT'|'SOL'; output: 'BERT'|'SOL' } {
    return fillSide === 'buy' ? { input: 'BERT', output: 'SOL' } : { input: 'SOL', output: 'BERT' };
  }

  async onFill(fill: Fill, solUsd: Decimal): Promise<void> {
    const hedgeId = nextHedgeId();
    const tIntent = new Date().toISOString();
    const dir = this.hedgeDir(fill.side);

    // Sell-side: Kraken filled a BERT sell, so we need to BUY BERT back on DEX.
    // amountIn is SOL = (BERT volume * BERT price in USD) / (SOL price in USD).
    const amountIn = dir.input === 'BERT'
      ? fill.volume
      : fill.volume.mul(fill.price).div(solUsd);

    // BERT notional for in-flight inventory accounting, SIGNED as net BERT *outflow*:
    //   buy fill  → we sell BERT on the DEX → BERT leaves us  → positive
    //   sell fill → we buy BERT on the DEX  → BERT arrives    → negative
    // NetDeltaTracker subtracts this signed quantity, so an in-flight hedge is counted
    // as already settled in whichever direction it actually moves inventory.
    const bertNotional = (dir.input === 'BERT' ? fill.volume : fill.volume.neg()).toString();

    let attempt = 0;
    const maxRetries = this.opts.maxRetries ?? 3;
    let lastQuote: SwapQuote | null = null;
    let lastSig: string | null = null;

    // Everything below runs against a row that sumInFlightHedgesBert() counts as in-flight,
    // i.e. as good as settled. If any step throws, that row would sit non-terminal forever
    // and the tracker would report a flat book while the Kraken leg is genuinely unhedged —
    // so the catch drives the row to a terminal status before rethrowing. The intent write
    // is inside the try as well: if it fails we never hedge at all, which is the same
    // exposure and equally deserves a page.
    try {
      await this.opts.store.writeHedge({
        hedgeId, triggeringFillId: fill.fillId, status: 'intent_queued',
        jupiterQuote: null, txSig: null, slippageRealized: null,
        bertNotional, tIntent, tConfirmed: null,
      });

      while (attempt <= maxRetries) {
        const quote = await this.opts.dex.estimateSwap(dir.input, dir.output, amountIn);
        lastQuote = quote;

        await this.opts.store.writeHedge({
          hedgeId, triggeringFillId: fill.fillId, status: 'swap_quoted',
          jupiterQuote: quote.routeJson, txSig: null, slippageRealized: null,
          bertNotional, tIntent, tConfirmed: null,
        });

        if (quote.priceImpactBps > this.opts.maxDexSlippageBps) {
          await this.opts.store.writeHedge({
            hedgeId, triggeringFillId: fill.fillId, status: 'slippage_aborted',
            jupiterQuote: quote.routeJson, txSig: null,
            slippageRealized: String(quote.priceImpactBps),
            bertNotional, tIntent, tConfirmed: null,
          });
          this.opts.notifier.page(`hedge ${hedgeId} aborted: priceImpact ${quote.priceImpactBps}bps > ${this.opts.maxDexSlippageBps}bps`);
          return;
        }

        const sig = await this.opts.dex.submitSwap(quote, { jito: true, tipLamports: this.opts.jitoTipLamports });
        lastSig = sig;
        await this.opts.store.writeHedge({
          hedgeId, triggeringFillId: fill.fillId, status: 'tx_submitted',
          jupiterQuote: quote.routeJson, txSig: sig, slippageRealized: null,
          bertNotional, tIntent, tConfirmed: null,
        });

        // Poll confirmation.
        const status = await this.pollUntilTerminal(sig);
        if (status === 'confirmed') {
          await this.opts.store.markConfirmed(hedgeId, sig, String(quote.priceImpactBps));
          return;
        }

        if (status === 'timeout') {
          // AMBIGUOUS: the tx may still land. Resubmitting here is how one Kraken fill
          // turns into two DEX hedges, so stop and hand it to a human instead.
          await this.opts.store.writeHedge({
            hedgeId, triggeringFillId: fill.fillId, status: 'failed_dead_letter',
            jupiterQuote: quote.routeJson, txSig: sig, slippageRealized: null,
            bertNotional, tIntent, tConfirmed: null,
          });
          this.opts.notifier.page(
            `hedge ${hedgeId} confirmation timed out; tx ${sig} may still land, verify before acting — ` +
            `not resubmitting (would double-hedge); ${bertNotional} BERT from fill ${fill.fillId}`,
          );
          return;
        }

        // Definitively failed on chain → safe to retry.
        attempt += 1;
        if (attempt > maxRetries) break;
        await this.opts.store.writeHedge({
          hedgeId, triggeringFillId: fill.fillId, status: 'failed_will_retry',
          jupiterQuote: quote.routeJson, txSig: sig, slippageRealized: null,
          bertNotional, tIntent, tConfirmed: null,
        });
      }

      await this.opts.store.writeHedge({
        hedgeId, triggeringFillId: fill.fillId, status: 'failed_dead_letter',
        jupiterQuote: lastQuote?.routeJson ?? null, txSig: lastSig, slippageRealized: null,
        bertNotional, tIntent, tConfirmed: null,
      });
      this.opts.notifier.page(`hedge ${hedgeId} dead-lettered after ${maxRetries} retries; lastSig=${lastSig ?? 'n/a'}`);
    } catch (err) {
      // Best-effort: if the store itself is what failed, the page below is the last defense.
      try {
        await this.opts.store.writeHedge({
          hedgeId, triggeringFillId: fill.fillId, status: 'failed_dead_letter',
          jupiterQuote: lastQuote?.routeJson ?? null, txSig: lastSig, slippageRealized: null,
          bertNotional, tIntent, tConfirmed: null,
        });
      } catch { /* store unreachable; fall through to the page */ }
      this.opts.notifier.page(
        `hedge ${hedgeId} failed before confirmation (${err instanceof Error ? err.message : String(err)}); ` +
        `unhedged ${bertNotional} BERT from fill ${fill.fillId}` +
        (lastSig ? ` — tx ${lastSig} may still land, verify` : ''),
      );
      throw err;
    }
  }

  /**
   * 'failed' means the chain definitively rejected the tx (safe to resubmit).
   * 'timeout' means we simply stopped hearing back — the tx may yet land, so the two
   * must never be conflated: only the former may be retried.
   */
  private async pollUntilTerminal(sig: string): Promise<'confirmed'|'failed'|'timeout'> {
    if (!this.opts.txStatus) {
      // No status function configured (tests without confirmation flow) → treat as confirmed
      // so behavior matches v0 expectations.
      return 'confirmed';
    }
    const interval = this.opts.pollIntervalMs ?? 2_000;
    const timeout = this.opts.pollTimeoutMs ?? 30_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const s = await this.opts.txStatus(sig);
      if (s === 'confirmed') return 'confirmed';
      if (s === 'failed') return 'failed';
      await new Promise(r => setTimeout(r, interval));
    }
    return 'timeout';
  }
}
