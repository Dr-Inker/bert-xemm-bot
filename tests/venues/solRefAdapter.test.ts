import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JupiterSolRef } from '../../src/venues/solRefAdapter.js';
import { MINT } from '../../src/venues/jupiterApi.js';

describe('JupiterSolRef', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('parses Jupiter /price response and caches', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ data: { [MINT.SOL]: { price: 86.12 } } }),
    });
    const r = new JupiterSolRef();
    const a = await r.fetchSolUsd();
    const b = await r.fetchSolUsd();
    expect(a).toBe('86.12');
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('throws on non-ok response', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503 });
    const r = new JupiterSolRef({ cacheMs: 0 });
    await expect(r.fetchSolUsd()).rejects.toThrow(/503/);
  });
});
