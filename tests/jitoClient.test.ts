import { describe, it, expect, vi, afterEach } from 'vitest';
import { JitoClient } from '../src/jitoClient.js';

afterEach(() => { vi.unstubAllGlobals(); });

describe('JitoClient.submitBundle', () => {
  it('aborts a hung block-engine request instead of hanging forever', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
      })));
    const c = new JitoClient({ blockEngineUrl: 'https://jito.test' });
    await expect(c.submitBundle(['dHg='], 1000, 20)).rejects.toThrow();
  });

  it('passes an abort signal on submission', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ result: 'BUNDLE-1' }) });
    vi.stubGlobal('fetch', f);
    const c = new JitoClient({ blockEngineUrl: 'https://jito.test' });
    await expect(c.submitBundle(['dHg='], 1000)).resolves.toBe('BUNDLE-1');
    const init = f.mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
