import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { HedgeExecutor } from '../../src/strategy/hedgeExecutor.js';

const fill = {
  fillId: 'F1', orderClOrdId: 'cl-1', side: 'buy' as const,
  price: new Decimal('0.0177'), volume: new Decimal('1000'),
  fee: new Decimal('0.0044'), t: new Date('2026-05-20T00:00:00Z'),
};

describe('HedgeExecutor.onFill', () => {
  it('aborts when Jupiter slippage > maxDexSlippageBps', async () => {
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0040'), slippageBps: 200, routeJson: '{}',
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
    await exec.onFill(fill);
    expect(dex.submitSwap).not.toHaveBeenCalled();
    expect(store.writeHedge).toHaveBeenCalledWith(expect.objectContaining({ status: 'slippage_aborted' }));
    expect(notifier.page).toHaveBeenCalled();
  });

  it('happy path: submits swap and writes intent_queued → tx_submitted', async () => {
    const dex = {
      estimateSwap: vi.fn().mockResolvedValue({
        inputAsset: 'BERT', outputAsset: 'SOL', amountIn: new Decimal('1000'),
        expectedAmountOut: new Decimal('0.0045'), slippageBps: 50, routeJson: '{}',
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
    await exec.onFill(fill);
    expect(transitions).toEqual(expect.arrayContaining(['intent_queued', 'tx_submitted']));
  });
});
