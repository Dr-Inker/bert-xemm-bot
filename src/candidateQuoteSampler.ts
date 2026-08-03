import Decimal from 'decimal.js';
import type { BookSnapshot } from './types.js';
import { jupiterQuote, type QuoteArgs, type QuoteResp } from './venues/jupiterApi.js';
import { measureExecutableBuyExactOut, measureExecutableSell } from './observerEconomics.js';

export interface CandidateReference {
  sizeBert: Decimal;
  executableSellPriceUsd: Decimal;
  executableBuyPriceUsd: Decimal;
  sellImpactBps: Decimal;
  buyImpactBps: Decimal;
  sellRouteDeviationBps: Decimal;
  buyRouteDeviationBps: Decimal;
}

export interface CandidateEconomicSnapshot {
  asOf: Date;
  raydiumMidUsd: Decimal;
  solUsd: Decimal;
  krakenBid: Decimal;
  krakenAsk: Decimal;
  crossVenueDivergenceBps: Decimal;
  book: BookSnapshot;
  references: Map<string, CandidateReference>;
}

export interface CandidateSnapshotInput {
  sizesBert: Decimal[];
  raydiumMidUsd: Decimal;
  solUsd: Decimal;
  book: BookSnapshot;
  jupiterBaseUrl: string;
  slippageBps: number;
  quote?: typeof jupiterQuote;
  now?: () => Date;
}

/** Collect a complete two-way snapshot; callers only publish it on success. */
export async function measureCandidateSnapshot(i: CandidateSnapshotInput): Promise<CandidateEconomicSnapshot> {
  const bid = i.book.bids[0]?.price;
  const ask = i.book.asks[0]?.price;
  if (!bid || !ask) throw new Error('complete Kraken book required');
  const references = new Map<string, CandidateReference>();
  const uniqueSizes = [...new Map(i.sizesBert.map(size => [size.toString(), size])).values()];
  for (const sizeBert of uniqueSizes) {
    const executableInput = {
      sizeBert,
      raydiumMidUsd: i.raydiumMidUsd,
      solUsd: i.solUsd,
      jupiterBaseUrl: i.jupiterBaseUrl,
      slippageBps: i.slippageBps,
      ...(i.quote ? { quote: i.quote } : {}),
    };
    const sell = await measureExecutableSell(executableInput);
    const buy = await measureExecutableBuyExactOut(executableInput);
    references.set(sizeBert.toString(), {
      sizeBert,
      executableSellPriceUsd: sell.priceUsd,
      executableBuyPriceUsd: buy.priceUsd,
      sellImpactBps: sell.impactBps,
      buyImpactBps: buy.impactBps,
      sellRouteDeviationBps: deviationBps(sell.priceUsd, i.raydiumMidUsd),
      buyRouteDeviationBps: deviationBps(buy.priceUsd, i.raydiumMidUsd),
    });
  }
  const krakenMid = bid.plus(ask).div(2);
  return {
    asOf: (i.now ?? (() => new Date()))(),
    raydiumMidUsd: i.raydiumMidUsd,
    solUsd: i.solUsd,
    krakenBid: bid,
    krakenAsk: ask,
    crossVenueDivergenceBps: deviationBps(krakenMid, i.raydiumMidUsd),
    book: i.book,
    references,
  };
}

/** Serial quote scheduler that enforces the configured maximum start rate. */
export class JupiterQuoteRateLimiter {
  private chain: Promise<void> = Promise.resolve();
  private nextStartMs = 0;
  private readonly spacingMs: number;

  constructor(maxCallsPerSec: number, private quoteImpl: typeof jupiterQuote = jupiterQuote) {
    if (!Number.isFinite(maxCallsPerSec) || maxCallsPerSec <= 0) throw new Error('maxCallsPerSec must be positive');
    this.spacingMs = 1000 / maxCallsPerSec;
  }

  quote = (args: QuoteArgs): Promise<QuoteResp> => {
    const task = this.chain.then(async () => {
      const waitMs = Math.max(0, this.nextStartMs - Date.now());
      if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
      this.nextStartMs = Date.now() + this.spacingMs;
      return this.quoteImpl(args);
    });
    this.chain = task.then(() => undefined, () => undefined);
    return task;
  };
}

function deviationBps(a: Decimal, b: Decimal): Decimal {
  if (b.lte(0)) return new Decimal(Infinity);
  return a.div(b).minus(1).abs().mul(10_000);
}
