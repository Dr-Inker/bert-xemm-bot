import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  condNetDelta, condDailyPnl, condRaydium24hMin, condKraken24hMin,
} from '../../src/risk/conditions.js';

describe('kill conditions 1-4', () => {
  it('netDelta trips when |usdNet| > threshold', () => {
    const r = condNetDelta({ usdNet: new Decimal('600') }, { netDeltaUsd: 500 });
    expect(r.tripped).toBe(true);
    expect(r.action).toBe('cancel_all_reduce_only');
  });

  it('dailyPnl trips when realizedPlusUnrealizedPct < threshold', () => {
    const r = condDailyPnl({ pnlPct: -2.5 }, { dailyPnlPct: -2 });
    expect(r.tripped).toBe(true);
    expect(r.action).toBe('halt_24h');
  });

  it('raydium24hMin trips when 24h volume < threshold', () => {
    const r = condRaydium24hMin({ raydium24hVolUsd: new Decimal('15000') }, { raydium24hMinUsd: 20000 });
    expect(r.tripped).toBe(true);
    expect(r.action).toBe('exit_dex_leg');
  });

  it('kraken24hMin returns reduce_only_stop_quoting', () => {
    const r = condKraken24hMin({ kraken24hVolUsd: new Decimal('5000') }, { kraken24hMinUsd: 20000 });
    expect(r.tripped).toBe(true);
    expect(r.action).toBe('reduce_only_stop_quoting');
  });
});
