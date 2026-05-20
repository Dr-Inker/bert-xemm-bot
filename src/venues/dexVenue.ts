import Decimal from 'decimal.js';

export type Asset = 'BERT' | 'SOL' | 'USDC';

export interface PoolMid {
  mid: Decimal;
  solUsd: Decimal;
  asOf: Date;
}

export interface SwapQuote {
  inputAsset: Asset;
  outputAsset: Asset;
  amountIn: Decimal;
  expectedAmountOut: Decimal;
  slippageBps: number;
  routeJson: string;
}

export interface DexVenue {
  poolMidUsd(): Promise<PoolMid>;
  estimateSwap(input: Asset, output: Asset, amountIn: Decimal): Promise<SwapQuote>;
  submitSwap(quote: SwapQuote, opts: { jito: boolean; tipLamports: number }): Promise<string>;
  walletBalances(): Promise<{ bert: Decimal; sol: Decimal }>;
}
