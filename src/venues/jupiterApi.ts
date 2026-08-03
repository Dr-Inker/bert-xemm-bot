export const MINT = {
  BERT: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump',
  SOL:  'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
} as const;

export const DECIMALS: Record<keyof typeof MINT, number> = { BERT: 6, SOL: 9, USDC: 6 };

// Every call on the hedge path must be bounded: a hung request never reaches the
// caller's catch, so the hedge row would sit non-terminal (counted as in-flight,
// i.e. as good as settled) for as long as the socket stays open.
export const JUPITER_QUOTE_TIMEOUT_MS = 10_000;
export const JUPITER_SWAP_TIMEOUT_MS = 10_000;

export interface QuoteArgs { inputMint: string; outputMint: string; amount: string; slippageBps: number; baseUrl: string; timeoutMs?: number; swapMode?: 'ExactIn' | 'ExactOut' }
export interface QuoteResp { inAmount?: string; outAmount: string; otherAmountThreshold: string; slippageBps: number; routePlan: unknown[]; priceImpactPct: string; contextSlot: number; timeTaken: number }
export interface BuildSwapResp { swapTransaction: string }

export async function jupiterQuote(a: QuoteArgs): Promise<QuoteResp> {
  const url = new URL(`${a.baseUrl}/quote`);
  url.searchParams.set('inputMint', a.inputMint);
  url.searchParams.set('outputMint', a.outputMint);
  url.searchParams.set('amount', a.amount);
  url.searchParams.set('slippageBps', String(a.slippageBps));
  if (a.swapMode) url.searchParams.set('swapMode', a.swapMode);
  const r = await fetch(url.toString(), {
    signal: AbortSignal.timeout(a.timeoutMs ?? JUPITER_QUOTE_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`jupiter quote ${r.status}: ${await r.text()}`);
  return r.json() as Promise<QuoteResp>;
}

export async function jupiterBuildSwap(
  baseUrl: string, quoteResp: QuoteResp, userPublicKey: string, timeoutMs?: number,
): Promise<BuildSwapResp> {
  const r = await fetch(`${baseUrl}/swap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: quoteResp, userPublicKey, wrapAndUnwrapSol: true }),
    signal: AbortSignal.timeout(timeoutMs ?? JUPITER_SWAP_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`jupiter swap ${r.status}: ${await r.text()}`);
  return r.json() as Promise<BuildSwapResp>;
}
