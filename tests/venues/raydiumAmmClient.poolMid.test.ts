import { describe, it, expect, vi } from 'vitest';
import { RaydiumAmmClient } from '../../src/venues/raydiumAmmClient.js';

describe('RaydiumAmmClient.poolMidUsd', () => {
  it('computes BERT/USD mid from pool reserves and SOL/USD reference', async () => {
    const rpc = {
      getPoolState: vi.fn().mockResolvedValue({ baseVault: 'BV', quoteVault: 'QV', baseDecimals: 6, quoteDecimals: 9 }),
      getTokenBalance: vi.fn(async (acct: string) => acct === 'BV'
        ? { uiAmount: '29390000', amount: '29390000000000', decimals: 6 }
        : { uiAmount: '6068',     amount: '6068000000000',   decimals: 9 }),
    };
    const solRef = { fetchSolUsd: vi.fn().mockResolvedValue('86.12') };
    const submitter = { submitProtected: vi.fn() };
    const c = new RaydiumAmmClient(
      { poolAddress: 'BmsZE6Tk', rpcUrl: 'mock://', jitoBlockEngine: 'mock://' },
      rpc as never, solRef as never, submitter as never,
    );
    const m = await c.poolMidUsd();
    expect(parseFloat(m.mid.toFixed(4))).toBeCloseTo(0.0178, 3);
    expect(m.solUsd.toString()).toBe('86.12');
  });
});
