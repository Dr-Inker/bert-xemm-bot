import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SolanaRpcAdapter } from '../../src/venues/solanaRpcAdapter.js';

describe('SolanaRpcAdapter', () => {
  let connection: { getTokenAccountBalance: ReturnType<typeof vi.fn>; getBalance: ReturnType<typeof vi.fn>; getParsedTokenAccountsByOwner: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    connection = { getTokenAccountBalance: vi.fn(), getBalance: vi.fn(), getParsedTokenAccountsByOwner: vi.fn() };
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('getPoolState calls DexScreener and caches result', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ pair: { baseToken: { address: 'BERT', decimals: 6 }, quoteToken: { address: 'SOL', decimals: 9 } } }),
    });
    const a = new SolanaRpcAdapter({ connection: connection as never, poolAddress: 'P1', bertMint: 'BERT' });
    const s1 = await a.getPoolState('P1');
    const s2 = await a.getPoolState('P1');
    expect(s1.baseDecimals).toBe(6);
    expect(s1.quoteDecimals).toBe(9);
    expect(fetch).toHaveBeenCalledTimes(1); // cached
    expect(s1).toEqual(s2);
  });

  it('getTokenBalance with dex: prefix reads liquidity from DexScreener', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ pair: { liquidity: { base: 1000, quote: 2 }, baseToken: { decimals: 6 }, quoteToken: { decimals: 9 } } }),
    });
    const a = new SolanaRpcAdapter({ connection: connection as never, poolAddress: 'P1', bertMint: 'BERT' });
    const b = await a.getTokenBalance('dex:P1:base');
    expect(b.uiAmount).toBe('1000');
    expect(b.decimals).toBe(6);
  });

  it('getWalletBalances returns zeros when no hot wallet configured', async () => {
    const a = new SolanaRpcAdapter({ connection: connection as never, poolAddress: 'P1', bertMint: 'BERT' });
    const r = await a.getWalletBalances();
    expect(r).toEqual({ bert: '0', sol: '0' });
  });

  it('getWalletBalances reads on-chain SOL and parsed BERT ATA when wallet set', async () => {
    connection.getBalance.mockResolvedValue(720_000_000); // 0.72 SOL lamports
    connection.getParsedTokenAccountsByOwner.mockResolvedValue({
      value: [{ account: { data: { parsed: { info: { tokenAmount: { uiAmountString: '2564' } } } } } }],
    });
    const a = new SolanaRpcAdapter({ connection: connection as never, poolAddress: 'P1', hotWalletPubkey: '4yw8AnCG5TwVgqUP1rgVfnBePZZVdSzMAcrzx86GHRCa', bertMint: 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump' });
    const r = await a.getWalletBalances();
    expect(r.sol).toBe('0.72');
    expect(r.bert).toBe('2564');
  });
});
