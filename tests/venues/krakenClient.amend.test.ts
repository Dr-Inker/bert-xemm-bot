import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { KrakenClient } from '../../src/venues/krakenClient.js';
import * as exec from '../../src/utils/execFileNoThrow.js';

const cfg = { cliBinaryPath: '/usr/local/bin/kraken', pair: 'BERTUSD', apiKeyEnv: 'K', apiSecretEnv: 'S', paper: false };

describe('KrakenClient.amend', () => {
  it('issues amend with --deadline clamped to [2,60]', async () => {
    const spy = vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({ stdout: '{}', stderr: '', status: 0 });
    const c = new KrakenClient(cfg);
    await c.amend({ venueOrderId: 'OXYZ', price: new Decimal('0.0177'), deadlineSec: 10 });
    const args = spy.mock.calls[0]![1];
    expect(args).toContain('amend');
    expect(args).toContain('--txid');
    expect(args).toContain('OXYZ');
    expect(args).toContain('--limit-price');
    expect(args).toContain('0.0177');
    expect(args).toContain('--deadline');
    expect(args).toContain('+10s');
  });

  it('clamps deadlineSec below 2 to 2 and above 60 to 60', async () => {
    const spy = vi.spyOn(exec, 'execFileNoThrow').mockResolvedValue({ stdout: '{}', stderr: '', status: 0 });
    const c = new KrakenClient(cfg);
    await c.amend({ venueOrderId: 'O1', price: new Decimal('0.01'), deadlineSec: 1 });
    expect(spy.mock.calls[0]![1].join(' ')).toContain('--deadline +2s');
    await c.amend({ venueOrderId: 'O1', price: new Decimal('0.01'), deadlineSec: 999 });
    expect(spy.mock.calls[1]![1].join(' ')).toContain('--deadline +60s');
  });
});
