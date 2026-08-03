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

export interface ExecutablePriceInput {
  sizeBert: Decimal;
  raydiumMidUsd: Decimal;
  solUsd: Decimal;
  jupiterBaseUrl: string;
  slippageBps: number;
  quote?: typeof jupiterQuote;
}

export interface ExecutablePrice {
  priceUsd: Decimal;
  impactBps: Decimal;
}

/** Measure both hedge directions with executable Jupiter quotes.
 * buyMakerEdge: rest a Kraken bid, then sell acquired BERT on-chain.
 * sellMakerEdge: rest a Kraken ask, then buy replacement BERT on-chain.
 */
export async function measureObserverEconomics(i: ObserverEconomicsInput): Promise<ObserverEconomics> {
  const executableInput: ExecutablePriceInput = {
    sizeBert: i.sizeBert,
    raydiumMidUsd: i.raydiumMidUsd,
    solUsd: i.solUsd,
    jupiterBaseUrl: i.jupiterBaseUrl,
    slippageBps: i.slippageBps,
  };
  if (i.quote) executableInput.quote = i.quote;
  const sell = await measureExecutableSell(executableInput);
  const buy = await measureExecutableBuy(executableInput);
  const dexSellPriceUsd = sell.priceUsd;
  const dexBuyPriceUsd = buy.priceUsd;
  const fee = new Decimal(i.makerFeeBps);
  return {
    dexSellPriceUsd,
    dexBuyPriceUsd,
    buyMakerEdgeBps: dexSellPriceUsd.div(i.krakenBid).minus(1).mul(10_000).minus(fee),
    sellMakerEdgeBps: i.krakenAsk.div(dexBuyPriceUsd).minus(1).mul(10_000).minus(fee),
    dexSellImpactBps: sell.impactBps,
    dexBuyImpactBps: buy.impactBps,
  };
}

/** Exact-input executable proceeds for selling the requested BERT size. */
export async function measureExecutableSell(i: ExecutablePriceInput): Promise<ExecutablePrice> {
  const quote = i.quote ?? jupiterQuote;
  const bertAtomic = i.sizeBert.mul(new Decimal(10).pow(DECIMALS.BERT)).floor().toFixed(0);
  const sell = await quote({
    inputMint: MINT.BERT, outputMint: MINT.SOL, amount: bertAtomic,
    slippageBps: i.slippageBps, baseUrl: i.jupiterBaseUrl,
  });
  const sellSol = atomic(sell, DECIMALS.SOL);
  return { priceUsd: sellSol.mul(i.solUsd).div(i.sizeBert), impactBps: impact(sell) };
}

/**
 * Size-normalised executable cost for buying the requested BERT size. Jupiter
 * is queried with exact-input SOL, then refined once to converge on the target.
 */
export async function measureExecutableBuy(i: ExecutablePriceInput): Promise<ExecutablePrice> {
  const quote = i.quote ?? jupiterQuote;
  let solIn = i.sizeBert.mul(i.raydiumMidUsd).div(i.solUsd);
  let buy = await buyQuote(quote, i, solIn);
  let bertOut = atomic(buy, DECIMALS.BERT);
  if (bertOut.gt(0)) {
    solIn = solIn.mul(i.sizeBert).div(bertOut);
    buy = await buyQuote(quote, i, solIn);
    bertOut = atomic(buy, DECIMALS.BERT);
  }
  if (bertOut.lte(0)) throw new Error('Jupiter returned zero BERT');
  return { priceUsd: solIn.mul(i.solUsd).div(bertOut), impactBps: impact(buy) };
}

/** Exact-output executable cost for the candidate lane's requested BERT size. */
export async function measureExecutableBuyExactOut(i: ExecutablePriceInput): Promise<ExecutablePrice> {
  const quote = i.quote ?? jupiterQuote;
  const bertAtomic = i.sizeBert.mul(new Decimal(10).pow(DECIMALS.BERT)).floor().toFixed(0);
  const buy = await quote({
    inputMint: MINT.SOL,
    outputMint: MINT.BERT,
    amount: bertAtomic,
    slippageBps: i.slippageBps,
    baseUrl: i.jupiterBaseUrl,
    swapMode: 'ExactOut',
  });
  if (!buy.inAmount) throw new Error('Jupiter ExactOut quote returned no input amount');
  const solIn = new Decimal(buy.inAmount).div(new Decimal(10).pow(DECIMALS.SOL));
  return { priceUsd: solIn.mul(i.solUsd).div(i.sizeBert), impactBps: impact(buy) };
}

async function buyQuote(quote: typeof jupiterQuote, i: ExecutablePriceInput, solIn: Decimal): Promise<QuoteResp> {
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
