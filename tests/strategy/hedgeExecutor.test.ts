import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { HedgeExecutor } from '../../src/strategy/hedgeExecutor.js';

const fill = {
  fillId: 'F1', orderClOrdId: 'cl-1', side: 'buy' as const,
  price: new Decimal('0.0177'), volume: new Decimal('1000'),
  fee: new Decimal('0.0044'), t: new Date('2026-05-20T00:00:00Z'),
};

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

  it('retry path: 1 timeout then confirmed → 2 submissions, no dead-letter', async () => {
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
    // First sig: pending forever (times out). Second sig: confirmed.
    const txStatus = vi.fn((sig: string) => Promise.resolve(sig === 'SIG-1' ? 'pending' : 'confirmed'));
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
