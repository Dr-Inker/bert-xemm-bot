export const MINT = {
  BERT: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

export const DECIMALS: Record<keyof typeof MINT, number> = { BERT: 6, SOL: 9, USDC: 6 };

export interface QuoteArgs { inputMint: string; outputMint: string; amount: string; slippageBps: number; baseUrl: string }
export interface QuoteResp { outAmount: string; otherAmountThreshold: string; slippageBps: number; routePlan: unknown[]; priceImpactPct: string; contextSlot: number; timeTaken: number }
export interface BuildSwapResp { swapTransaction: string }

export async function jupiterQuote(a: QuoteArgs): Promise<QuoteResp> {
  const url = new URL(`${a.baseUrl}/quote`);
  url.searchParams.set('inputMint', a.inputMint);
  url.searchParams.set('outputMint', a.outputMint);
  url.searchParams.set('amount', a.amount);
  url.searchParams.set('slippageBps', String(a.slippageBps));
  const r = await fetch(url.toString());
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${await r.text()}`);
  return r.json() as Promise<QuoteResp>;
}

export async function jupiterBuildSwap(baseUrl: string, quoteResp: QuoteResp, userPublicKey: string): Promise<BuildSwapResp> {
  const r = await fetch(`${baseUrl}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quoteResp, userPublicKey, wrapAndUnwrapSol: true }),
  });
  if (!r.ok) throw new Error(`jupiter swap ${r.status}: ${await r.text()}`);
  return r.json() as Promise<BuildSwapResp>;
}
