import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { KrakenClient } from '../../src/venues/krakenClient.js';
import * as exec from '../../src/utils/execFileNoThrow.js';

const cfg = {
  cliBinaryPath: '/usr/local/bin/kraken',
  pair: 'BERTUSD',
  apiKeyEnv: 'KRAKEN_API_KEY',
  apiSecretEnv: 'KRAKEN_API_SECRET',
  paper: false,
};

describe('KrakenClient mutations', () => {
  it('placeLimit shells out with --oflags post and returns venueOrderId', async () => {
    const spy = vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ txid: ['OABC123'] }),
      stderr: '', status: 0,
    });
    const c = new KrakenClient(cfg);
    const id = await c.placeLimit({
      side: 'buy', price: new Decimal('0.0177'), volume: new Decimal('1000'),
      postOnly: true, clOrdId: 'cl-1',
    });
    expect(id).toBe('OABC123');
    const args = spy.mock.calls[0]![1];
    expect(args).toContain('order'); expect(args).toContain('buy');
    expect(args).toContain('--type'); expect(args).toContain('limit');
    expect(args).toContain('--oflags'); expect(args).toContain('post');
    expect(args).toContain('--cl-ord-id'); expect(args).toContain('cl-1');
  });

  it('maps rate_limit envelope to VenueError(category=rate_limit, retryable=true)', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ error: { category: 'rate_limit', message: 'too fast', retryable: true, retry_after_ms: 500 } }),
      stderr: '', status: 1,
    });
    const c = new KrakenClient(cfg);
    await expect(c.placeLimit({
      side: 'sell', price: new Decimal('0.0177'), volume: new Decimal('1000'),
      postOnly: true, clOrdId: 'cl-2',
    })).rejects.toMatchObject({ category: 'rate_limit', retryable: true, retryAfterMs: 500 });
  });

  it('cancelAll passes --yes', async () => {
    const spy = vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ count: 3 }), stderr: '', status: 0,
    });
    const c = new KrakenClient(cfg);
    const r = await c.cancelAll();
    expect(r.cancelled).toBe(3);
    expect(spy.mock.calls[0]![1]).toContain('cancel-all');
    expect(spy.mock.calls[0]![1]).toContain('--yes');
  });

  it('cancelAfter passes the seconds arg', async () => {
    const spy = vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ currentTime: 't', triggerTime: 't+0' }), stderr: '', status: 0,
    });
    const c = new KrakenClient(cfg);
    await c.cancelAfter(30);
    expect(spy.mock.calls[0]![1]).toContain('cancel-after');
    expect(spy.mock.calls[0]![1]).toContain('30');
  });
});
