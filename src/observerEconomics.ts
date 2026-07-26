import Decimal from 'decimal.js';
import { DECIMALS, MINT, jupiterQuote, type QuoteResp } from './venues/jupiterApi.js';

export interface ObserverEconomicsInput {
  sizeBert: Decimal;
  krakenBid: Decimal;
  krakenAsk: Decimal;
  raydiumMidUsd: Decimal;
  solUsd: Decimal;
  makerFeeBps: number;
  jupiterBaseUrl: string;
  slippageBps: number;
  quote?: typeof jupiterQuote;
}

export interface ObserverEconomics {
  dexSellPriceUsd: Decimal;
  dexBuyPriceUsd: Decimal;
  buyMakerEdgeBps: Decimal;
  sellMakerEdgeBps: Decimal;
  dexSellImpactBps: Decimal;
  dexBuyImpactBps: Decimal;
}

/** Measure both hedge directions with executable Jupiter quotes.
 * buyMakerEdge: rest a Kraken bid, then sell acquired BERT on-chain.
 * sellMakerEdge: rest a Kraken ask, then buy replacement BERT on-chain.
 */
export async function measureObserverEconomics(i: ObserverEconomicsInput): Promise<ObserverEconomics> {
  const quote = i.quote ?? jupiterQuote;
  const bertAtomic = i.sizeBert.mul(new Decimal(10).pow(DECIMALS.BERT)).floor().toFixed(0);
  const sell = await quote({
    inputMint: MINT.BERT, outputMint: MINT.SOL, amount: bertAtomic,
    slippageBps: i.slippageBps, baseUrl: i.jupiterBaseUrl,
  });
  const sellSol = atomic(sell, DECIMALS.SOL);
  const dexSellPriceUsd = sellSol.mul(i.solUsd).div(i.sizeBert);

  // Seed exact-input SOL from the reference mid, then refine once using the
  // returned BERT quantity. This produces a size-normalised executable cost.
  let solIn = i.sizeBert.mul(i.raydiumMidUsd).div(i.solUsd);
  let buy = await buyQuote(quote, i, solIn);
  let bertOut = atomic(buy, DECIMALS.BERT);
  if (bertOut.gt(0)) {
    solIn = solIn.mul(i.sizeBert).div(bertOut);
    buy = await buyQuote(quote, i, solIn);
    bertOut = atomic(buy, DECIMALS.BERT);
  }
  if (bertOut.lte(0)) throw new Error('Jupiter returned zero BERT');
  const dexBuyPriceUsd = solIn.mul(i.solUsd).div(bertOut);
  const fee = new Decimal(i.makerFeeBps);
  return {
    dexSellPriceUsd,
    dexBuyPriceUsd,
    buyMakerEdgeBps: dexSellPriceUsd.div(i.krakenBid).minus(1).mul(10_000).minus(fee),
    sellMakerEdgeBps: i.krakenAsk.div(dexBuyPriceUsd).minus(1).mul(10_000).minus(fee),
    dexSellImpactBps: impact(sell),
    dexBuyImpactBps: impact(buy),
  };
}

async function buyQuote(quote: typeof jupiterQuote, i: ObserverEconomicsInput, solIn: Decimal): Promise<QuoteResp> {
  return quote({
    inputMint: MINT.SOL, outputMint: MINT.BERT,
    amount: solIn.mul(new Decimal(10).pow(DECIMALS.SOL)).floor().toFixed(0),
    slippageBps: i.slippageBps, baseUrl: i.jupiterBaseUrl,
  });
}

function atomic(q: QuoteResp, decimals: number): Decimal {
  return new Decimal(q.outAmount).div(new Decimal(10).pow(decimals));
}

function impact(q: QuoteResp): Decimal {
  return new Decimal(q.priceImpactPct || 0).mul(100);
}
