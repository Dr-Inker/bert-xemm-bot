import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { KrakenPublicTrades } from '../../src/venues/krakenPublicTrades.js';
import * as streamMod from '../../src/venues/krakenStream.js';

function fakeChild(line: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: Readable; stderr: Readable; kill: () => void };
  child.stdout = Readable.from([`${line}\n`]);
  child.stderr = Readable.from([]);
  child.kill = vi.fn();
  return child;
}

describe('KrakenPublicTrades', () => {
  it('delivers every valid public trade in one burst and retains a missing side as null', async () => {
    vi.spyOn(streamMod, 'spawnKrakenStream').mockReturnValue(fakeChild(JSON.stringify({
      channel: 'trade',
      data: [
        { trade_id: 1, side: 'sell', price: 0.1, qty: 10, timestamp: '2026-08-03T00:00:00Z' },
        { trade_id: 2, price: 0.101, qty: 20, timestamp: '2026-08-03T00:00:01Z' },
      ],
    })) as never);
    const logger = { warn: vi.fn() };
    const stream = new KrakenPublicTrades('/kraken', 'BERTUSD', logger as never);
    const batches: Array<Array<{ tradeId: number; side: string | null }>> = [];
    stream.onBatch(trades => {
      batches.push(trades.map(trade => ({ tradeId: trade.tradeId, side: trade.side })));
      stream.shutdown();
    });

    await stream.run();
    expect(batches).toEqual([[
      { tradeId: 1, side: 'sell' },
      { tradeId: 2, side: null },
    ]]);
  });
});
