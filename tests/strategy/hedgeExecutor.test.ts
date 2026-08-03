import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { HedgeExecutor } from '../../src/strategy/hedgeExecutor.js';
import { StateStore } from '../../src/stateStore.js';

const fill = {
  fillId: 'F1', orderClOrdId: 'cl-1', side: 'buy' as const,
  price: new Decimal('0.0177'), volume: new Decimal('1000'),
  fee: new Decimal('0.0044'), t: new Date('2026-05-20T00:00:00Z'),
};

const sellFillF9 = {
  fillId: 'F9', orderClOrdId: 'cl-9', side: 'sell' as const,
  price: new Decimal('0.0177'), volume: new Decimal('1000'),
  fee: new Decimal('0.0044'), t: new Date('2026-05-20T00:00:00Z'),
};

// Same wiring main.ts uses: HedgeExecutor writes through to the real StateStore,
// so the in-flight sum is exercised end to end.
function realStore(): { store: StateStore; hedgeStore: ConstructorParameters<typeof HedgeExecutor>[0]['store'] } {
  const store = new StateStore(':memory:');
  return {
    store,
    hedgeStore: {
      writeHedge: async (r) => { store.insertHedgeRow(r); },
      readInFlight: async () => store.sumInFlightHedgesBert(),
      markConfirmed: async (id, sig, slip) => { store.markHedgeConfirmed(id, sig, slip); },
    },
  };
}

describe('HedgeExecutor.onFill', () => {
  it('aborts when Jupiter priceImpact > maxDexSlippageBps', async () => {
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0040'), slippageBps: 50, priceImpactBps: 200, routeJson: '{}',
      }),
      submitSwap: vi.fn(),
    };
    const store = {
      writeHedge: vi.fn(),
      readInFlight: vi.fn().mockResolvedValue(new Decimal('0')),
    };
    const notifier = { page: vi.fn() };
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never, notifier: notifier as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    await exec.onFill(fill, new Decimal('86.12'));
    expect(dex.submitSwap).not.toHaveBeenCalled();
    expect(store.writeHedge).toHaveBeenCalledWith(expect.objectContaining({
      status: 'slippage_aborted',
      slippageRealized: '200',
    }));
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('priceImpact 200bps'));
  });

  it('happy path: submits swap and writes intent_queued → tx_submitted', async () => {
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0045'), slippageBps: 50, priceImpactBps: 50, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockResolvedValue('SIG-OK'),
    };
    const transitions: string[] = [];
    const store = {
      writeHedge: vi.fn((row: { status: string }) => { transitions.push(row.status); }),
      readInFlight: vi.fn().mockResolvedValue(new Decimal('0')),
      markConfirmed: vi.fn(),
    };
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never,
      notifier: { page: vi.fn() } as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    await exec.onFill(fill, new Decimal('86.12'));
    expect(transitions).toEqual(expect.arrayContaining(['intent_queued', 'tx_submitted']));
  });

  it('sell-side fill: amountIn is SOL (= USD notional / solUsd), not USD', async () => {
    const sellFill = {
      fillId: 'F2', orderClOrdId: 'cl-2', side: 'sell' as const,
      price: new Decimal('0.0177'), volume: new Decimal('1000'),
      fee: new Decimal('0.0044'), t: new Date('2026-05-20T00:00:00Z'),
    };
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'SOL', outputAsset: 'BERT', amountIn: new Decimal('0.205'),
        expectedAmountOut: new Decimal('1000'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockResolvedValue('SIG-SELL'),
    };
    const store = { writeHedge: vi.fn(), readInFlight: vi.fn().mockResolvedValue(new Decimal('0')), markConfirmed: vi.fn() };
    const exec = new HedgeExecutor({ dex: dex as never, store: store as never, notifier: { page: vi.fn() } as never, maxDexSlippageBps: 100, jitoTipLamports: 10_000 });
    await exec.onFill(sellFill, new Decimal('86.12'));
    // 1000 * 0.0177 / 86.12 = 0.2056... SOL
    const call = dex.estimateSwap.mock.calls[0]!;
    expect(call[0]).toBe('SOL');
    expect(call[1]).toBe('BERT');
    const amountIn = call[2] as Decimal;
    expect(parseFloat(amountIn.toFixed(4))).toBeCloseTo(0.2056, 3);
  });

  it('buy fill → DEX sell-hedge writes a POSITIVE (outflow) bertNotional', async () => {
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0045'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockResolvedValue('SIG-BUY'),
    };
    const store = { writeHedge: vi.fn(), readInFlight: vi.fn().mockResolvedValue(new Decimal('0')), markConfirmed: vi.fn() };
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never, notifier: { page: vi.fn() } as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    await exec.onFill(fill, new Decimal('86.12'));
    expect(store.writeHedge).toHaveBeenCalledWith(expect.objectContaining({
      status: 'intent_queued', bertNotional: '1000',
    }));
  });

  it('sell fill → DEX buy-hedge writes a NEGATIVE (inflow) bertNotional', async () => {
    const sellFill = {
      fillId: 'F3', orderClOrdId: 'cl-3', side: 'sell' as const,
      price: new Decimal('0.0177'), volume: new Decimal('1000'),
      fee: new Decimal('0.0044'), t: new Date('2026-05-20T00:00:00Z'),
    };
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'SOL', outputAsset: 'BERT', amountIn: new Decimal('0.2056'),
        expectedAmountOut: new Decimal('1000'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockResolvedValue('SIG-SELL2'),
    };
    const store = { writeHedge: vi.fn(), readInFlight: vi.fn().mockResolvedValue(new Decimal('0')), markConfirmed: vi.fn() };
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never, notifier: { page: vi.fn() } as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    await exec.onFill(sellFill, new Decimal('86.12'));
    expect(store.writeHedge).toHaveBeenCalledWith(expect.objectContaining({
      status: 'intent_queued', bertNotional: '-1000',
    }));
  });

  it('estimateSwap throwing leaves a terminal row excluded from the in-flight sum', async () => {
    const { store, hedgeStore } = realStore();
    const dex = {
      estimateSwap: vi.fn().mockRejectedValue(new Error('jupiter 502')),
      submitSwap: vi.fn(),
    };
    const notifier = { page: vi.fn() };
    const exec = new HedgeExecutor({
      dex: dex as never, store: hedgeStore, notifier: notifier as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    // The 1000-BERT Kraken sell is real exposure; the failed hedge must not mask it.
    await expect(exec.onFill(sellFillF9, new Decimal('86.12'))).rejects.toThrow('jupiter 502');
    expect(store.sumInFlightHedgesBert().toString()).toBe('0');
    expect(dex.submitSwap).not.toHaveBeenCalled();
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('unhedged'));
  });

  it('submitSwap throwing leaves a terminal row excluded from the in-flight sum', async () => {
    const { store, hedgeStore } = realStore();
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'SOL', outputAsset: 'BERT', amountIn: new Decimal('0.2056'),
        expectedAmountOut: new Decimal('1000'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockRejectedValue(new Error('blockhash expired')),
    };
    const notifier = { page: vi.fn() };
    const exec = new HedgeExecutor({
      dex: dex as never, store: hedgeStore, notifier: notifier as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    await expect(exec.onFill(sellFillF9, new Decimal('86.12'))).rejects.toThrow('blockhash expired');
    expect(store.sumInFlightHedgesBert().toString()).toBe('0');
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('unhedged'));
  });

  it('still counts a genuinely in-flight hedge, and drops it once confirmed', async () => {
    const { store, hedgeStore } = realStore();
    let sumMidFlight = '';
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'SOL', outputAsset: 'BERT', amountIn: new Decimal('0.2056'),
        expectedAmountOut: new Decimal('1000'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      // Sampled while the row sits at swap_quoted — the hedge really is in flight here.
      submitSwap: vi.fn(() => {
        sumMidFlight = store.sumInFlightHedgesBert().toString();
        return Promise.resolve('SIG-INFLIGHT');
      }),
    };
    const exec = new HedgeExecutor({
      dex: dex as never, store: hedgeStore, notifier: { page: vi.fn() } as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    await exec.onFill(sellFillF9, new Decimal('86.12'));
    expect(sumMidFlight).toBe('-1000');
    expect(store.sumInFlightHedgesBert().toString()).toBe('0');
  });

  it('happy path: poll returns confirmed → markConfirmed called', async () => {
    vi.useFakeTimers();
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0045'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockResolvedValue('SIG-CONFIRM'),
    };
    const markConfirmed = vi.fn();
    const transitions: string[] = [];
    const store = {
      writeHedge: vi.fn((r: { status: string }) => { transitions.push(r.status); }),
      readInFlight: vi.fn().mockResolvedValue(new Decimal('0')),
      markConfirmed,
    };
    const txStatus = vi.fn().mockResolvedValue('confirmed');
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never,
      notifier: { page: vi.fn() } as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
      txStatus, pollIntervalMs: 50, pollTimeoutMs: 1_000,
    });
    const p = exec.onFill(fill, new Decimal('86.12'));
    await vi.runAllTimersAsync();
    await p;
    expect(markConfirmed).toHaveBeenCalledWith(expect.any(String), 'SIG-CONFIRM', '10');
    expect(transitions).toContain('intent_queued');
    expect(transitions).toContain('tx_submitted');
    vi.useRealTimers();
  });

  it('retry path: 1 definitive failure then confirmed → 2 submissions, no dead-letter', async () => {
    vi.useFakeTimers();
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0045'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn()
        .mockResolvedValueOnce('SIG-1')
        .mockResolvedValueOnce('SIG-2'),
    };
    const markConfirmed = vi.fn();
    const transitions: string[] = [];
    const store = {
      writeHedge: vi.fn((r: { status: string }) => { transitions.push(r.status); }),
      readInFlight: vi.fn().mockResolvedValue(new Decimal('0')),
      markConfirmed,
    };
    // First sig: definitively failed on chain (safe to resubmit). Second sig: confirmed.
    const txStatus = vi.fn((sig: string) => Promise.resolve(sig === 'SIG-1' ? 'failed' : 'confirmed'));
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never,
      notifier: { page: vi.fn() } as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
      txStatus: txStatus as never, pollIntervalMs: 50, pollTimeoutMs: 200,
    });
    const p = exec.onFill(fill, new Decimal('86.12'));
    await vi.runAllTimersAsync();
    await p;
    expect(dex.submitSwap).toHaveBeenCalledTimes(2);
    expect(transitions).toContain('failed_will_retry');
    expect(markConfirmed).toHaveBeenCalledWith(expect.any(String), 'SIG-2', '10');
    vi.useRealTimers();
  });

  it('confirmation TIMEOUT does not resubmit: dead-letters and pages to verify the tx', async () => {
    vi.useFakeTimers();
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0045'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockResolvedValue('SIG-PENDING'),
    };
    const transitions: string[] = [];
    const store = {
      writeHedge: vi.fn((r: { status: string }) => { transitions.push(r.status); }),
      readInFlight: vi.fn().mockResolvedValue(new Decimal('0')),
      markConfirmed: vi.fn(),
    };
    const notifier = { page: vi.fn() };
    // Never resolves either way — the ambiguous case. Resubmitting here double-hedges.
    const txStatus = vi.fn().mockResolvedValue('pending');
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never, notifier: notifier as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
      txStatus, pollIntervalMs: 50, pollTimeoutMs: 200, maxRetries: 3,
    });
    const p = exec.onFill(fill, new Decimal('86.12'));
    await vi.runAllTimersAsync();
    await p;
    expect(dex.submitSwap).toHaveBeenCalledTimes(1);
    expect(transitions).not.toContain('failed_will_retry');
    expect(transitions).toContain('failed_dead_letter');
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('SIG-PENDING'));
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('may still land'));
    vi.useRealTimers();
  });

  it('pages when the initial intent row cannot even be written', async () => {
    const dex = { estimateSwap: vi.fn(), submitSwap: vi.fn() };
    const store = {
      writeHedge: vi.fn().mockRejectedValue(new Error('sqlite locked')),
      readInFlight: vi.fn().mockResolvedValue(new Decimal('0')),
      markConfirmed: vi.fn(),
    };
    const notifier = { page: vi.fn() };
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never, notifier: notifier as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
    });
    await expect(exec.onFill(sellFillF9, new Decimal('86.12'))).rejects.toThrow('sqlite locked');
    expect(dex.estimateSwap).not.toHaveBeenCalled();
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('unhedged'));
  });

  it('dead-letter: 3 retries exhausted', async () => {
    vi.useFakeTimers();
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0045'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}',
      }),
      submitSwap: vi.fn().mockResolvedValue('SIG-X'),
    };
    const transitions: string[] = [];
    const store = {
      writeHedge: vi.fn((r: { status: string }) => { transitions.push(r.status); }),
      readInFlight: vi.fn().mockResolvedValue(new Decimal('0')),
      markConfirmed: vi.fn(),
    };
    const txStatus = vi.fn().mockResolvedValue('failed');
    const notifier = { page: vi.fn() };
    const exec = new HedgeExecutor({
      dex: dex as never, store: store as never,
      notifier: notifier as never,
      maxDexSlippageBps: 100, jitoTipLamports: 10_000,
      txStatus, pollIntervalMs: 50, pollTimeoutMs: 200, maxRetries: 3,
    });
    const p = exec.onFill(fill, new Decimal('86.12'));
    await vi.runAllTimersAsync();
    await p;
    expect(transitions).toContain('failed_dead_letter');
    expect(notifier.page).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
