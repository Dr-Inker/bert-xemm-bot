import Decimal from 'decimal.js';
import type { Logger } from '../logger.js';

export interface Raydium24hVolOpts {
  poolAddress: string;
  ttlMs?: number;
  logger?: Logger;
}

export class Raydium24hVol {
  private cache: { value: Decimal; at: number } | null = null;

  constructor(private opts: Raydium24hVolOpts) {}

  async fetch(): Promise<Decimal> {
    const ttl = this.opts.ttlMs ?? 300_000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.value;
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${this.opts.poolAddress}`);
      if (!r.ok) throw new Error(`dexscreener ${r.status}`);
      const j = await r.json() as { pair?: { volume?: { h24?: number | string } } };
      const v = j.pair?.volume?.h24;
      const value = new Decimal(typeof v === 'number' ? v : (v ?? '0'));
      this.cache = { value, at: Date.now() };
      return value;
    } catch (err) {
      this.opts.logger?.warn({ err }, 'raydium 24h volume fetch failed; treating as 0');
      return new Decimal(0);
    }
  }
}
