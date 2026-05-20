import Decimal from 'decimal.js';
import type { DexVenue, PoolMid, SwapQuote, Asset } from './dexVenue.js';

export interface RaydiumAmmConfig {
  poolAddress: string;
  rpcUrl: string;
  jitoBlockEngine: string;
}

export interface RpcAdapter {
  getPoolState(poolAddress: string): Promise<{ baseVault: string; quoteVault: string; baseDecimals: number; quoteDecimals: number }>;
  getTokenBalance(account: string): Promise<{ uiAmount: string; amount: string; decimals: number }>;
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

  estimateSwap(_i: Asset, _o: Asset, _a: Decimal): Promise<SwapQuote> {
    throw new Error('estimateSwap not implemented yet (Task 13)');
  }
  submitSwap(_q: SwapQuote, _o: { jito: boolean; tipLamports: number }): Promise<string> {
    throw new Error('submitSwap not implemented yet (Task 13)');
  }
  walletBalances(): Promise<{ bert: Decimal; sol: Decimal }> {
    throw new Error('walletBalances not implemented yet (Task 13)');
  }
}
