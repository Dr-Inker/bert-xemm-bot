import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { RaydiumAmmClient } from '../../src/venues/raydiumAmmClient.js';
import * as jupApi from '../../src/venues/jupiterApi.js';

const rpc = {
  getPoolState: vi.fn(),
  getTokenBalance: vi.fn(),
  getWalletBalances: vi.fn(async () => ({ bert: '2564', sol: '0.72' })),
};
const solRef = { fetchSolUsd: vi.fn().mockResolvedValue('86.12') };
const submitter = { submitProtected: vi.fn(async () => 'SIG-DEAD-BEEF') };

describe('RaydiumAmmClient swap path', () => {
  it('estimateSwap calls jupiter quote with the right mints and slippage', async () => {
    const spy = vi.spyOn(jupApi, 'jupiterQuote').mockResolvedValue({
      outAmount: '4500000', otherAmountThreshold: '4400000', slippageBps: 50,
      routePlan: [], priceImpactPct: '0.001', contextSlot: 1, timeTaken: 0,
    });
    const c = new RaydiumAmmClient({ poolAddress: 'P', rpcUrl: 'mock://', jitoBlockEngine: 'mock://' }, rpc as never, solRef as never, submitter as never);
    const q = await c.estimateSwap('BERT', 'SOL', new Decimal('1000'));
    expect(q.expectedAmountOut.gt(0)).toBe(true);
    expect(q.priceImpactBps).toBe(10);
    const args = spy.mock.calls[0]![0];
    expect(args.inputMint).toBe('HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump');
    expect(args.outputMint).toBe('So11111111111111111111111111111111111111112');
  });

  it('submitSwap calls submitter.submitProtected and returns the tx sig', async () => {
    vi.spyOn(jupApi, 'jupiterBuildSwap').mockResolvedValue({ swapTransaction: 'base64-tx-bytes' });
    const c = new RaydiumAmmClient({ poolAddress: 'P', rpcUrl: 'mock://', jitoBlockEngine: 'mock://' }, rpc as never, solRef as never, submitter as never);
    const sig = await c.submitSwap({
      inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
      expectedAmountOut: new Decimal('0.0044'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
    }, { jito: true, tipLamports: 10_000 });
    expect(sig).toBe('SIG-DEAD-BEEF');
  });
});
