import { describe, it, expect, vi } from 'vitest';
import { KrakenPaper } from '../../src/venues/krakenPaper.js';
import * as exec from '../../src/utils/execFileNoThrow.js';

describe('KrakenPaper', () => {
  it('prefixes argv with `paper` for placeLimit', async () => {
    const spy = vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ txid: ['P-OABC'] }), stderr: '', status: 0,
    });
    const Decimal = (await import('decimal.js')).default;
    const p = new KrakenPaper({ cliBinaryPath: '/k', pair: 'BERTUSD' });
    await p.placeLimit({ side: 'buy', price: new Decimal('0.0177'), volume: new Decimal('1000'), postOnly: true, clOrdId: 'cl-p1' });
    const args = spy.mock.calls[0]![1];
    expect(args[0]).toBe('paper');
    expect(args).toContain('order'); expect(args).toContain('buy');
  });

  it('feeTier returns Starter taker 26 bps with maker 0', async () => {
    const p = new KrakenPaper({ cliBinaryPath: '/k', pair: 'BERTUSD' });
    const t = await p.feeTier();
    expect(t.makerBps).toBe(0);
    expect(t.takerBps).toBe(26);
  });
});
