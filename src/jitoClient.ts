import { logger } from './logger.js';

/**
 * Jito Block Engine client for MEV-protected transaction submission.
 *
 * Bundles submitted here never hit the public mempool, eliminating
 * sandwich/frontrun attacks on our DEX swaps. Jito validators
 * (~65% of Solana block production) include bundles atomically.
 *
 * This is the simplified v1 used by bert-xemm-bot — caller is
 * responsible for tip-IX construction and signing. We just POST
 * the wire-format transaction to `sendBundle` and return the
 * bundle ID. Callers handle confirmation polling and fallback.
 */

// Default Jito tip accounts — one is picked at random per submission.
// Source: https://docs.jito.wtf/lowlatencytxnsend/#tip-amount
// Sanity-checked against live `getTipAccounts` on 2026-04-19.
export const DEFAULT_JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

/** Submission is bounded so a hung block engine cannot strand a hedge in flight. */
export const JITO_SUBMIT_TIMEOUT_MS = 15_000;

export interface JitoClientOptions {
  blockEngineUrl: string;
  tipAccounts?: string[];
}

export class JitoClient {
  private readonly blockEngineUrl: string;
  readonly tipAccounts: string[];

  constructor(opts: JitoClientOptions) {
    this.blockEngineUrl = opts.blockEngineUrl.replace(/\/$/, '');
    this.tipAccounts =
      opts.tipAccounts && opts.tipAccounts.length > 0
        ? opts.tipAccounts
        : DEFAULT_JITO_TIP_ACCOUNTS;
  }

  /**
   * Pick a tip account at random — Jito requires the bundle write-lock
   * at least one of the canonical tip accounts.
   */
  pickTipAccount(): string {
    const idx = Math.floor(Math.random() * this.tipAccounts.length);
    return this.tipAccounts[idx]!;
  }

  /**
   * Submit an array of base64-encoded wire-format transactions as a
   * single Jito bundle to the block engine. Returns the bundle ID.
   *
   * Throws on HTTP failure, JSON-RPC error, or empty result. Caller is
   * responsible for falling back to public RPC on any throw.
   *
   * The `tipLamports` argument is currently informational only —
   * the actual tip transfer instruction must already be included
   * inside one of the supplied transactions. We log it for traceability.
   */
  async submitBundle(serializedTxs: string[], tipLamports: number, timeoutMs?: number): Promise<string> {
    if (serializedTxs.length === 0) {
      throw new Error('jito: submitBundle called with empty tx list');
    }

    const res = await fetch(`${this.blockEngineUrl}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [serializedTxs, { encoding: 'base64' }],
      }),
      // Bounded: a hung block engine must surface as a failure the hedge path can act on.
      signal: AbortSignal.timeout(timeoutMs ?? JITO_SUBMIT_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`jito sendBundle HTTP ${res.status}: ${text}`);
    }

    const data = (await res.json()) as {
      result?: string;
      error?: { message?: string; code?: number };
    };

    if (data.error) {
      throw new Error(`jito sendBundle error: ${data.error.message ?? 'unknown'}`);
    }
    if (!data.result) {
      throw new Error('jito sendBundle returned empty result');
    }

    logger.info(
      { bundleId: data.result, tipLamports, txCount: serializedTxs.length },
      'jito bundle submitted',
    );
    return data.result;
  }
}
