import { describe, it, expect, vi, afterEach } from 'vitest';
import { jupiterQuote, jupiterBuildSwap, type QuoteResp } from '../../src/venues/jupiterApi.js';

// A fetch that never responds but honours AbortSignal — models a hung Jupiter edge node,
// which is exactly the case an unbounded fetch() turns into a permanently stuck hedge.
function hangingFetch() {
  return vi.fn((_url: string, init?: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
  }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('jupiterApi request timeouts', () => {
  it('jupiterQuote aborts instead of hanging forever', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    await expect(jupiterQuote({
      inputMint: 'A', outputMint: 'B', amount: '1', slippageBps: 50,
      baseUrl: 'https://jup.test', timeoutMs: 20,
    })).rejects.toThrow();
  });

  it('jupiterBuildSwap aborts instead of hanging forever', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    await expect(jupiterBuildSwap(
      'https://jup.test', {} as QuoteResp, 'PUBKEY', 20,
    )).rejects.toThrow();
  });

  it('passes an abort signal on every request', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', f);
    await jupiterQuote({
      inputMint: 'A', outputMint: 'B', amount: '1', slippageBps: 50, baseUrl: 'https://jup.test',
    });
    const init = f.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
