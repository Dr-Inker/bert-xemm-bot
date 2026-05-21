import Decimal from 'decimal.js';
import type { Fill, Side } from '../types.js';
import type { DexVenue } from '../venues/dexVenue.js';

export interface HedgeRow {
  hedgeId: string;
  triggeringFillId: string;
  status: 'intent_queued'|'swap_quoted'|'tx_submitted'|'confirmed'|'failed_will_retry'|'failed_dead_letter'|'slippage_aborted'|'cancelled_by_killswitch';
  jupiterQuote: string | null;
  txSig: string | null;
  slippageRealized: string | null;
  tIntent: string;
  tConfirmed: string | null;
}

export interface HedgeStore {
  writeHedge(row: HedgeRow): Promise<void>;
  readInFlight(): Promise<Decimal>;
  markConfirmed(txSig: string, slippageRealized: string): Promise<void>;
}

export interface HedgeExecutorOpts {
  dex: DexVenue;
  store: HedgeStore;
  notifier: { page(msg: string): void };
  maxDexSlippageBps: number;
  jitoTipLamports: number;
}

let _hedgeSeq = 0;
const nextHedgeId = () => `h-${Date.now().toString(36)}-${(++_hedgeSeq).toString(36)}`;

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

    await this.opts.store.writeHedge({
      hedgeId, triggeringFillId: fill.fillId, status: 'intent_queued',
      jupiterQuote: null, txSig: null, slippageRealized: null,
      tIntent, tConfirmed: null,
    });

    const quote = await this.opts.dex.estimateSwap(dir.input, dir.output, amountIn);
    await this.opts.store.writeHedge({
      hedgeId, triggeringFillId: fill.fillId, status: 'swap_quoted',
      jupiterQuote: quote.routeJson, txSig: null, slippageRealized: null,
      tIntent, tConfirmed: null,
    });

    if (quote.priceImpactBps > this.opts.maxDexSlippageBps) {
      await this.opts.store.writeHedge({
        hedgeId, triggeringFillId: fill.fillId, status: 'slippage_aborted',
        jupiterQuote: quote.routeJson, txSig: null, slippageRealized: String(quote.priceImpactBps),
        tIntent, tConfirmed: null,
      });
      this.opts.notifier.page(`hedge ${hedgeId} aborted: priceImpact ${quote.priceImpactBps}bps > ${this.opts.maxDexSlippageBps}bps`);
      return;
    }

    const sig = await this.opts.dex.submitSwap(quote, { jito: true, tipLamports: this.opts.jitoTipLamports });
    await this.opts.store.writeHedge({
      hedgeId, triggeringFillId: fill.fillId, status: 'tx_submitted',
      jupiterQuote: quote.routeJson, txSig: sig, slippageRealized: null,
      tIntent, tConfirmed: null,
    });
  }
}
