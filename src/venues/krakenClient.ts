import Decimal from 'decimal.js';
import { execFileNoThrow } from '../utils/execFileNoThrow.js';
import { mapKrakenError } from './krakenErrors.js';
import { spawnKrakenStream, ndjsonLines } from './krakenStream.js';
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

  async amend(p: AmendParams): Promise<void> {
    const clamped = Math.max(2, Math.min(60, Math.floor(p.deadlineSec)));
    const args = ['order', 'amend', '--txid', p.venueOrderId, '--deadline', `+${clamped}s`];
    if (p.price !== undefined) { args.push('--limit-price', p.price.toString()); }
    if (p.volume !== undefined) { args.push('--order-qty', p.volume.toString()); }
    await this.runJson<unknown>(args);
  }
  async *watchExecutions(): AsyncIterable<Fill> {
    const child = spawnKrakenStream(this.cfg.cliBinaryPath, [...this.base(), 'ws', 'executions']);
    try {
      for await (const event of ndjsonLines(child)) {
        const ev = event as { channel?: string; data?: { exec_type?: string; order_id?: string; symbol?: string; side?: 'buy'|'sell'; last_qty?: string; last_price?: string; fees?: { qty?: string }[]; timestamp?: string; exec_id?: string } };
        if (ev?.channel !== 'executions' || ev.data?.exec_type !== 'trade') continue;
        const d = ev.data;
        if (!d.order_id || !d.side || !d.last_qty || !d.last_price || !d.exec_id || !d.timestamp) continue;
        const fee = d.fees?.[0]?.qty ?? '0';
        yield {
          fillId: d.exec_id,
          orderClOrdId: d.order_id,
          side: d.side,
          price: new Decimal(d.last_price),
          volume: new Decimal(d.last_qty),
          fee: new Decimal(fee),
          t: new Date(d.timestamp),
        };
      }
    } finally { child.kill(); }
  }

  async *watchOrders(): AsyncIterable<OrderUpdate> {
    const child = spawnKrakenStream(this.cfg.cliBinaryPath, [...this.base(), 'ws', 'executions']);
    try {
      for await (const event of ndjsonLines(child)) {
        const ev = event as { channel?: string; data?: { exec_type?: string; order_id?: string; order_status?: string; cum_qty?: string; timestamp?: string } };
        if (ev?.channel !== 'executions') continue;
        const d = ev.data;
        if (!d?.order_id || !d.order_status || !d.timestamp) continue;
        const statusMap: Record<string, OrderUpdate['status']> = {
          new: 'open', open: 'open', cancelled: 'cancelled', filled: 'filled', partially_filled: 'partially_filled', rejected: 'rejected',
        };
        const status = statusMap[d.order_status] ?? 'open';
        yield {
          venueOrderId: d.order_id,
          status,
          filledVolume: new Decimal(d.cum_qty ?? '0'),
          t: new Date(d.timestamp),
        };
      }
    } finally { child.kill(); }
  }

  async *watchBook(pair: string, depth: number): AsyncIterable<BookSnapshot> {
    const child = spawnKrakenStream(this.cfg.cliBinaryPath, [...this.base(), 'ws', 'book', pair, '--depth', String(depth)]);
    try {
      for await (const event of ndjsonLines(child)) {
        const ev = event as { channel?: string; data?: { symbol?: string; bids?: { price: string; qty: string }[]; asks?: { price: string; qty: string }[]; timestamp?: string } };
        if (ev?.channel !== 'book' || !ev.data) continue;
        const d = ev.data;
        if (!d.bids || !d.asks || !d.symbol || !d.timestamp) continue;
        yield {
          pair: d.symbol,
          bids: d.bids.map(l => ({ price: new Decimal(l.price), volume: new Decimal(l.qty) })),
          asks: d.asks.map(l => ({ price: new Decimal(l.price), volume: new Decimal(l.qty) })),
          t: new Date(d.timestamp),
        };
      }
    } finally { child.kill(); }
  }
  async balances(): Promise<{ base: Decimal; quote: Decimal }> {
    const j = await this.runJson<Record<string, string>>(['account', 'balance']);
    const base = j['BERT'] ?? j['XBT'] ?? '0';
    const quote = j['ZUSD'] ?? j['USD'] ?? '0';
    return { base: new Decimal(base), quote: new Decimal(quote) };
  }

  async openOrders(): Promise<Order[]> {
    const j = await this.runJson<{ open?: Record<string, { descr: { type: 'buy'|'sell'; price: string; pair: string }; vol: string; vol_exec: string; status: string; opentm: number; userref?: number }> }>(['account', 'open-orders']);
    const out: Order[] = [];
    for (const [venueOrderId, o] of Object.entries(j.open ?? {})) {
      const statusMap: Record<string, Order['status']> = {
        open: 'open', cancelled: 'cancelled', closed: 'filled', expired: 'cancelled', pending: 'open',
      };
      out.push({
        clOrdId: String(o.userref ?? venueOrderId),
        venueOrderId,
        side: o.descr.type,
        price: new Decimal(o.descr.price),
        volume: new Decimal(o.vol),
        status: statusMap[o.status] ?? 'open',
        placedAt: new Date(o.opentm * 1000),
      });
    }
    return out;
  }

  async feeTier(): Promise<FeeTier> {
    const j = await this.runJson<{ fees?: Record<string, { fee_maker?: string; fee?: string }> }>(['volume', '--pair', this.cfg.pair]);
    const k = this.cfg.pair;
    const maker = j.fees?.[k]?.fee_maker ?? '0.16';
    const taker = j.fees?.[k]?.fee ?? '0.26';
    return { makerBps: Math.round(parseFloat(maker) * 100), takerBps: Math.round(parseFloat(taker) * 100) };
  }
}
