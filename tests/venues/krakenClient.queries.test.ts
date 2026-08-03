import { describe, it, expect, vi } from 'vitest';
import { KrakenClient } from '../../src/venues/krakenClient.js';
import * as exec from '../../src/utils/execFileNoThrow.js';
import { logger } from '../../src/logger.js';

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

  it('feeTier falls back to conservative maker/taker bps when the pair key is missing', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ fees: { XXBTZUSD: { fee_maker: '0.16', fee: '0.26' } } }), stderr: '', status: 0,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    const c = new KrakenClient(cfg);
    const t = await c.feeTier();
    expect(t.makerBps).toBe(25);
    expect(t.takerBps).toBe(40);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ pair: 'BERTUSD' }),
      expect.stringContaining('fee tier'),
    );
    warn.mockRestore();
  });

  it('feeTier falls back to conservative bps when the reported fee is unparseable', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ fees: { BERTUSD: { fee_maker: 'garbage', fee: '0.26' } } }), stderr: '', status: 0,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    const c = new KrakenClient(cfg);
    const t = await c.feeTier();
    expect(t.makerBps).toBe(25);
    expect(t.takerBps).toBe(40);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('feeTier falls back to conservative bps when a reported fee is negative', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ fees: { BERTUSD: { fee_maker: '-0.01', fee: '0.26' } } }), stderr: '', status: 0,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    const c = new KrakenClient(cfg);
    const t = await c.feeTier();
    expect(t.makerBps).toBe(25);
    expect(t.takerBps).toBe(40);
    warn.mockRestore();
  });

  it('feeTier rejects numeric-prefix garbage rather than reading it as a 0 bps fee', async () => {
    vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({
      stdout: JSON.stringify({ fees: { BERTUSD: { fee_maker: '0garbage', fee: '0.26' } } }), stderr: '', status: 0,
    });
    const warn = vi.spyOn(logger, 'warn').mockImplementation((() => undefined) as never);
    const c = new KrakenClient(cfg);
    const t = await c.feeTier();
    // parseFloat('0garbage') === 0 → a free maker fee → fail-open cheap quoting.
    expect(t.makerBps).toBe(25);
    expect(t.takerBps).toBe(40);
    warn.mockRestore();
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
