import Decimal from 'decimal.js';
import type { DexVenue, PoolMid, SwapQuote, Asset } from './dexVenue.js';
import { MINT, DECIMALS, jupiterQuote, jupiterBuildSwap, type QuoteResp } from './jupiterApi.js';

export interface RaydiumAmmConfig {
  poolAddress: string;
  rpcUrl: string;
  jitoBlockEngine: string;
}

export interface RpcAdapter {
  getPoolState(poolAddress: string): Promise<{ baseVault: string; quoteVault: string; baseDecimals: number; quoteDecimals: number }>;
  getTokenBalance(account: string): Promise<{ uiAmount: string; amount: string; decimals: number }>;
  getWalletBalances(): Promise<{ bert: string; sol: string }>;
}

export interface SolRefAdapter {
  fetchSolUsd(): Promise<string>;
}

export interface TxSubmitter {
  submitProtected(serializedTx: string, opts: { jito: boolean; tipLamports: number }): Promise<string>;
}

export class RaydiumAmmClient implements DexVenue {
  constructor(
    private cfg: RaydiumAmmConfig,
    private rpc: RpcAdapter,
    private solRef: SolRefAdapter,
    private submitter: TxSubmitter,
    private hotWalletPubkey: string = '',
    private jupiterBaseUrl: string = 'https://quote-api.jup.ag/v6',
    private quoterSlippageBps: number = 50,
  ) {}

  async poolMidUsd(): Promise<PoolMid> {
    const pool = await this.rpc.getPoolState(this.cfg.poolAddress);
    const [base, quote, solUsdStr] = await Promise.all([
      this.rpc.getTokenBalance(pool.baseVault),
      this.rpc.getTokenBalance(pool.quoteVault),
      this.solRef.fetchSolUsd(),
    ]);
    const baseUi = new Decimal(base.uiAmount);
    const quoteUi = new Decimal(quote.uiAmount);
    if (baseUi.isZero()) throw new Error('raydium pool baseVault empty');
    const bertPerSol = quoteUi.div(baseUi);
    const solUsd = new Decimal(solUsdStr);
    const mid = bertPerSol.mul(solUsd);
    return { mid, solUsd, asOf: new Date() };
  }

  async estimateSwap(input: Asset, output: Asset, amountIn: Decimal): Promise<SwapQuote> {
    const inputMint = MINT[input];
    const outputMint = MINT[output];
    const amount = amountIn.mul(new Decimal(10).pow(DECIMALS[input])).toFixed(0);
    const q = await jupiterQuote({
      inputMint, outputMint, amount, slippageBps: this.quoterSlippageBps, baseUrl: this.jupiterBaseUrl,
    });
    const outDecimals = DECIMALS[output];
    const expectedOut = new Decimal(q.outAmount).div(new Decimal(10).pow(outDecimals));
    return {
      inputAsset: input, outputAsset: output, amountIn, expectedAmountOut: expectedOut,
      slippageBps: q.slippageBps,
      priceImpactBps: Math.round(parseFloat(q.priceImpactPct) * 10_000),
      routeJson: JSON.stringify(q),
    };
  }

  async submitSwap(quote: SwapQuote, opts: { jito: boolean; tipLamports: number }): Promise<string> {
    const q = JSON.parse(quote.routeJson) as QuoteResp;
    const built = await jupiterBuildSwap(this.jupiterBaseUrl, q, this.hotWalletPubkey);
    return this.submitter.submitProtected(built.swapTransaction, opts);
  }

  async walletBalances(): Promise<{ bert: Decimal; sol: Decimal }> {
    const b = await this.rpc.getWalletBalances();
    return { bert: new Decimal(b.bert), sol: new Decimal(b.sol) };
  }
}
