import Decimal from 'decimal.js';
import { spawnKrakenStream, ndjsonLines } from './krakenStream.js';
import { toWsPair } from './krakenPair.js';
import type { Logger } from '../logger.js';

export interface PublicTrade {
  tradeId: number;
  side: 'buy' | 'sell' | null;
  price: Decimal;
  volume: Decimal;
  t: Date;
}

export class KrakenPublicTrades {
  private stop = false;
  private listeners = new Set<(trade: PublicTrade) => Promise<void> | void>();
  private batchListeners = new Set<(trades: PublicTrade[]) => Promise<void> | void>();
  constructor(private binary: string, private pair: string, private logger: Logger) {}
  onTrade(fn: (trade: PublicTrade) => Promise<void> | void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  onBatch(fn: (trades: PublicTrade[]) => Promise<void> | void): () => void {
    this.batchListeners.add(fn);
    return () => this.batchListeners.delete(fn);
  }
  async run(): Promise<void> {
    while (!this.stop) {
      const child = spawnKrakenStream(this.binary, ['ws', 'trades', toWsPair(this.pair), '--snapshot', 'false']);
      try {
        for await (const event of ndjsonLines(child)) {
          if (this.stop) break;
          const ev = event as { channel?: string; data?: Array<{ trade_id?: number; side?: string; price?: number; qty?: number; timestamp?: string }> };
          if (ev.channel !== 'trade') continue;
          const trades: PublicTrade[] = [];
          for (const d of ev.data ?? []) {
            if (d.trade_id === undefined || d.price === undefined || d.qty === undefined || !d.timestamp) continue;
            const side = d.side === 'buy' || d.side === 'sell' ? d.side : null;
            trades.push({ tradeId: d.trade_id, side, price: new Decimal(d.price), volume: new Decimal(d.qty), t: new Date(d.timestamp) });
          }
          if (trades.length === 0) continue;
          for (const fn of this.batchListeners) {
            try {
              void Promise.resolve(fn(trades)).catch(err => this.logger.warn({ err }, 'public trades batch listener failed'));
            } catch (err) {
              this.logger.warn({ err }, 'public trades batch listener failed');
            }
          }
          for (const trade of trades) {
            for (const fn of this.listeners) {
              try {
                void Promise.resolve(fn(trade)).catch(err => this.logger.warn({ err }, 'public trade listener failed'));
              } catch (err) {
                this.logger.warn({ err }, 'public trade listener failed');
              }
            }
          }
        }
      } catch (err) {
        this.logger.warn({ err }, 'public trades stream errored; reconnecting');
      } finally { child.kill(); }
      if (!this.stop) await new Promise(r => setTimeout(r, 5_000));
    }
  }
  shutdown(): void { this.stop = true; }
}
