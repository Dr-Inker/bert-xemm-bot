import Decimal from 'decimal.js';
import type { HedgeVenue } from '../venues/hedgeVenue.js';
import type { DexVenue } from '../venues/dexVenue.js';

export interface EmergencyUnwindOpts {
  cex: HedgeVenue;
  dex: DexVenue;
  notifier: { page(msg: string): void };
  store: { setFlag(k: string, v: string): void };
  minOrderBert: Decimal;
  jitoTipLamports?: number;
}

export async function runEmergencyUnwind(opts: EmergencyUnwindOpts): Promise<void> {
  await opts.cex.cancelAll();
  await opts.cex.cancelAfter(0);

  const dexBal = await opts.dex.walletBalances();
  if (dexBal.bert.gt(opts.minOrderBert)) {
    const q = await opts.dex.estimateSwap('BERT', 'SOL', dexBal.bert);
    await opts.dex.submitSwap(q, { jito: true, tipLamports: opts.jitoTipLamports ?? 10_000 });
  }

  const cexBal = await opts.cex.balances();
  if (cexBal.base.gt(opts.minOrderBert)) {
    opts.notifier.page(`emergency: BERT=${cexBal.base.toString()} still on Kraken; manual market-sell required (no auto-sell wired in v1).`);
  }

  if (cexBal.quote.gt(0)) {
    opts.notifier.page(`emergency: USD on Kraken=${cexBal.quote.toString()}. Withdraw permission is intentionally OFF; operator must withdraw via Kraken UI.`);
  }

  opts.store.setFlag('emergency_unwind_complete', '1');
  opts.store.setFlag('degraded', '1');
}
