import type { SolRefAdapter } from './raydiumAmmClient.js';
import { MINT } from './jupiterApi.js';

export interface JupiterSolRefOpts {
  baseUrl?: string;        // default https://price.jup.ag/v4
  cacheMs?: number;        // default 30_000
}

export class JupiterSolRef implements SolRefAdapter {
  private cache: { value: string; at: number } | null = null;
  constructor(private opts: JupiterSolRefOpts = {}) {}
  async fetchSolUsd(): Promise<string> {
    const ttl = this.opts.cacheMs ?? 30_000;
    if (this.cache && Date.now() - this.cache.at < ttl) return this.cache.value;
    const base = this.opts.baseUrl ?? 'https://price.jup.ag/v4';
    const url = `${base}/price?ids=${MINT.SOL}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`jupiter price ${r.status}`);
    const j = await r.json() as { data?: Record<string, { price?: number }> };
    const price = j.data?.[MINT.SOL]?.price;
    if (typeof price !== 'number') throw new Error(`jupiter price missing SOL`);
    const value = String(price);
    this.cache = { value, at: Date.now() };
    return value;
  }
}
