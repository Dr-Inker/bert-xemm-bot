import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { runEmergencyUnwind } from '../../src/risk/emergencyUnwind.js';

describe('runEmergencyUnwind', () => {
  it('cancels all and submits DEX BERT to SOL when DEX wallet has BERT', async () => {
    const cex = {
      cancelAll: vi.fn().mockResolvedValue({ cancelled: 2 }),
      cancelAfter: vi.fn(),
      balances: vi.fn().mockResolvedValue({ base: new Decimal('0'), quote: new Decimal('100') }),
    };
    const dex = {
      walletBalances: vi.fn().mockResolvedValue({ bert: new Decimal('1000'), sol: new Decimal('0.1') }),
      estimateSwap: vi.fn().mockResolvedValue({ inputAsset:'BERT', outputAsset:'SOL', amountIn: new Decimal('1000'), expectedAmountOut: new Decimal('0.005'), slippageBps: 50, priceImpactBps: 10, routeJson: '{}' }),
      submitSwap: vi.fn().mockResolvedValue('SIG-EMERGENCY'),
    };
    const notifier = { page: vi.fn() };
    const store = { setFlag: vi.fn() };
    await runEmergencyUnwind({ cex: cex as never, dex: dex as never, notifier: notifier as never, store: store as never, minOrderBert: new Decimal('380') });
    expect(cex.cancelAll).toHaveBeenCalled();
    expect(cex.cancelAfter).toHaveBeenCalledWith(0);
    expect(dex.submitSwap).toHaveBeenCalled();
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('USD on Kraken'));
    expect(store.setFlag).toHaveBeenCalledWith('emergency_unwind_complete', '1');
  });

  it('skips DEX swap when BERT < minOrderBert (dust)', async () => {
    const cex = { cancelAll: vi.fn().mockResolvedValue({ cancelled: 0 }), cancelAfter: vi.fn(), balances: vi.fn().mockResolvedValue({ base: new Decimal('0'), quote: new Decimal('0') }) };
    const dex = {
      walletBalances: vi.fn().mockResolvedValue({ bert: new Decimal('100'), sol: new Decimal('0') }),
      estimateSwap: vi.fn(),
      submitSwap: vi.fn(),
    };
    await runEmergencyUnwind({
      cex: cex as never, dex: dex as never,
      notifier: { page: vi.fn() } as never, store: { setFlag: vi.fn() } as never,
      minOrderBert: new Decimal('380'),
    });
    expect(dex.submitSwap).not.toHaveBeenCalled();
  });
});
