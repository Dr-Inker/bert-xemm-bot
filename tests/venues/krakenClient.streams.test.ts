import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { KrakenClient } from '../../src/venues/krakenClient.js';
import * as streamMod from '../../src/venues/krakenStream.js';

function makeFakeChild(lines: string[]) {
  const stdout = Readable.from(lines.map(l => l + '\n'));
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void };
  (child as any).stdout = stdout;
  (child as any).stderr = Readable.from([]);
  (child as any).kill = vi.fn();
  return child;
}

describe('KrakenClient streams', () => {
  it('yields Fill events parsed from NDJSON executions stream', async () => {
    vi.spyOn(streamMod, 'spawnKrakenStream').mockReturnValue(makeFakeChild([
      JSON.stringify({ channel: 'executions', data: { exec_type: 'trade', order_id: 'OABC', symbol: 'BERT/USD', side: 'buy', last_qty: '100', last_price: '0.0177', fees: [{ asset: 'USD', qty: '0.0044' }], timestamp: '2026-05-20T00:00:00Z', exec_id: 'EX1' } }),
    ]) as never);
    const c = new KrakenClient({ cliBinaryPath: '/k', pair: 'BERTUSD', apiKeyEnv: 'K', apiSecretEnv: 'S', paper: false });
    const iter = c.watchExecutions()[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.orderClOrdId).toBeDefined();
    expect(first.value?.side).toBe('buy');
    expect(first.value?.volume.toString()).toBe('100');
  });
});
