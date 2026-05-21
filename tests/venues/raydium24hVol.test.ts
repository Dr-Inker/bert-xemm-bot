import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Raydium24hVol } from '../../src/venues/raydium24hVol.js';

describe('Raydium24hVol', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('parses h24 volume and caches', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true, json: async () => ({ pair: { volume: { h24: 168_000 } } }),
    });
    const r = new Raydium24hVol({ poolAddress: 'P' });
    const a = await r.fetch();
    const b = await r.fetch();
    expect(a.toString()).toBe('168000');
    expect(a.equals(b)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('returns 0 on fetch failure', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'));
    const r = new Raydium24hVol({ poolAddress: 'P', ttlMs: 0 });
    const v = await r.fetch();
    expect(v.toString()).toBe('0');
  });

  it('returns 0 when h24 missing', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => ({ pair: { volume: {} } }) });
    const r = new Raydium24hVol({ poolAddress: 'P', ttlMs: 0 });
    const v = await r.fetch();
    expect(v.toString()).toBe('0');
  });
});
