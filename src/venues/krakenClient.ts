import Decimal from 'decimal.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { mapKrakenError } from './krakenErrors.js';
import { VenueError, type HedgeVenue, type PlaceLimitParams, type AmendParams } from './hedgeVenue.js';
import type { Fill, OrderUpdate, BookSnapshot, Order, FeeTier } from '../types.js';

export interface KrakenClientConfig {
  cliBinaryPath: string;
  pair: string;
  apiKeyEnv: string;
  apiSecretEnv: string;
  paper: boolean;
}

export class KrakenClient implements HedgeVenue {
  constructor(protected cfg: KrakenClientConfig) {}

  protected base(): string[] {
    return this.cfg.paper ? ['paper'] : [];
  }

  protected async runJson<T>(args: string[]): Promise<T> {
    const env = { ...process.env };
    const full = [...this.base(), ...args, '-o', 'json'];
    const r = await execFileNoThrow(this.cfg.cliBinaryPath, full, { env, strictArgs: true, timeoutMs: 15_000 });
    let parsed: unknown;
    try { parsed = JSON.parse(r.stdout || '{}'); }
    catch { throw new VenueError('parse', `kraken stdout not JSON: ${r.stdout.slice(0,200)}`, false); }
    const mapped = mapKrakenError(parsed as { error?: { category?: string; message?: string; retryable?: boolean; retry_after_ms?: number } }, full.join(' '));
    if (mapped) throw mapped;
    if (r.status !== 0) throw new VenueError('api', `kraken exit=${r.status}: ${r.stderr.slice(0,200)}`, false);
    return parsed as T;
  }

  async placeLimit(p: PlaceLimitParams): Promise<string> {
    const args = [
      'order', p.side, this.cfg.pair, p.volume.toString(),
      '--type', 'limit',
      '--price', p.price.toString(),
      '--oflags', 'post',
      '--cl-ord-id', p.clOrdId,
    ];
    const r = await this.runJson<{ txid: string[] }>(args);
    const id = r.txid?.[0];
    if (!id) throw new VenueError('parse', 'kraken placeLimit returned no txid', false);
    return id;
  }

  async cancel(venueOrderId: string): Promise<void> {
    await this.runJson<unknown>(['order', 'cancel', venueOrderId]);
  }

  async cancelAll(): Promise<{ cancelled: number }> {
    const r = await this.runJson<{ count?: number }>(['order', 'cancel-all', '--yes']);
    return { cancelled: r.count ?? 0 };
  }

  async cancelAfter(seconds: number): Promise<void> {
    await this.runJson<unknown>(['order', 'cancel-after', String(seconds)]);
  }

  amend(_p: AmendParams): Promise<void> { throw new Error('amend not implemented yet (Task 7)'); }
  watchExecutions(): AsyncIterable<Fill> { throw new Error('watchExecutions not implemented yet (Task 8)'); }
  watchOrders(): AsyncIterable<OrderUpdate> { throw new Error('not implemented yet (Task 8)'); }
  watchBook(_p: string, _d: number): AsyncIterable<BookSnapshot> { throw new Error('not implemented yet (Task 8)'); }
  balances(): Promise<{ base: Decimal; quote: Decimal }> { throw new Error('not implemented yet (Task 9)'); }
  openOrders(): Promise<Order[]> { throw new Error('not implemented yet (Task 9)'); }
  feeTier(): Promise<FeeTier> { throw new Error('not implemented yet (Task 9)'); }
}
