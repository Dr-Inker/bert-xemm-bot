import Decimal from 'decimal.js';

export type KillAction =
  | 'cancel_all_reduce_only' | 'halt_24h' | 'exit_dex_leg'
  | 'reduce_only_stop_quoting' | 'pause_new_mark_to_market'
  | 'halt_rpc' | 'withdraw_30min' | 'cancel_all_refuse_resume';

export interface KillResult { tripped: boolean; reason?: string | undefined; action: KillAction }

export function condNetDelta(s: { usdNet: Decimal }, t: { netDeltaUsd: number }): KillResult {
  const tripped = s.usdNet.abs().gt(t.netDeltaUsd);
  return { tripped, reason: tripped ? `|usdNet|=${s.usdNet.abs().toString()} > ${t.netDeltaUsd}` : undefined, action: 'cancel_all_reduce_only' };
}

export function condDailyPnl(s: { pnlPct: number }, t: { dailyPnlPct: number }): KillResult {
  const tripped = s.pnlPct < t.dailyPnlPct;
  return { tripped, reason: tripped ? `pnlPct=${s.pnlPct} < ${t.dailyPnlPct}` : undefined, action: 'halt_24h' };
}

export function condRaydium24hMin(s: { raydium24hVolUsd: Decimal }, t: { raydium24hMinUsd: number }): KillResult {
  const tripped = s.raydium24hVolUsd.lt(t.raydium24hMinUsd);
  return { tripped, reason: tripped ? `raydium24h=${s.raydium24hVolUsd.toString()} < ${t.raydium24hMinUsd}` : undefined, action: 'exit_dex_leg' };
}

export function condKraken24hMin(s: { kraken24hVolUsd: Decimal }, t: { kraken24hMinUsd: number }): KillResult {
  const tripped = s.kraken24hVolUsd.lt(t.kraken24hMinUsd);
  return { tripped, reason: tripped ? `kraken24h=${s.kraken24hVolUsd.toString()} < ${t.kraken24hMinUsd}` : undefined, action: 'reduce_only_stop_quoting' };
}
