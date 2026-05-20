import { describe, it, expect, vi } from 'vitest';
import { KrakenClient } from '../../src/venues/krakenClient.js';
import * as exec from '../../src/utils/execFileNoThrow.js';

const cfg = { cliBinaryPath: '/k', pair: 'BERTUSD', apiKeyEnv: 'K', apiSecretEnv: 'S', paper: false };

describe('KrakenClient queries', () => {
  it('balances returns Decimal pair from balance JSON', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ BERT: '12345.6', ZUSD: '987.65' }), stderr: '', status: 0,
    });
    const c = new KrakenClient(cfg);
    const b = await c.balances();
    expect(b.base.toString()).toBe('12345.6');
    expect(b.quote.toString()).toBe('987.65');
  });

  it('feeTier returns maker/taker bps from volume JSON', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ fees: { BERTUSD: { fee_maker: '0.16', fee: '0.26' } } }), stderr: '', status: 0,
    });
    const c = new KrakenClient(cfg);
    const t = await c.feeTier();
    expect(t.makerBps).toBe(16);
    expect(t.takerBps).toBe(26);
  });

  it('openOrders parses array correctly', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({
        open: {
          OXYZ: { descr: { type: 'buy', price: '0.0177', pair: 'BERTUSD' }, vol: '1000', vol_exec: '0', status: 'open', userref: 0, opentm: 1747700000 },
        },
      }), stderr: '', status: 0,
    });
    const c = new KrakenClient(cfg);
    const orders = await c.openOrders();
    expect(orders).toHaveLength(1);
    expect(orders[0]?.venueOrderId).toBe('OXYZ');
    expect(orders[0]?.side).toBe('buy');
  });
});
