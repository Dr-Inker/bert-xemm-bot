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

export function condSolUsd1hMove(s: { pctMove1h: number }, t: { solUsd1hMaxAbsPct: number }): KillResult {
  const tripped = Math.abs(s.pctMove1h) > t.solUsd1hMaxAbsPct;
  return { tripped, reason: tripped ? `solUsd1hMove=${s.pctMove1h}% > +/-${t.solUsd1hMaxAbsPct}%` : undefined, action: 'pause_new_mark_to_market' };
}

export function condRpcBurn(s: { callsPerMin: number }, t: { rpcCallsPerMinHalt: number }): KillResult {
  const tripped = s.callsPerMin > t.rpcCallsPerMinHalt;
  return { tripped, reason: tripped ? `rpc=${s.callsPerMin}/min > ${t.rpcCallsPerMinHalt}` : undefined, action: 'halt_rpc' };
}

export function condAdverseFill(s: { adverseShareLast20: number }, t: { adverseFillRateMax: number }): KillResult {
  const tripped = s.adverseShareLast20 > t.adverseFillRateMax;
  return { tripped, reason: tripped ? `adverse=${(s.adverseShareLast20*100).toFixed(0)}% > ${(t.adverseFillRateMax*100).toFixed(0)}%` : undefined, action: 'withdraw_30min' };
}

export function condStaleData(s: { oldestSourceAgeSec: number }, t: { staleDataSeconds: number }): KillResult {
  const tripped = s.oldestSourceAgeSec > t.staleDataSeconds;
  return { tripped, reason: tripped ? `staleSec=${s.oldestSourceAgeSec} > ${t.staleDataSeconds}` : undefined, action: 'cancel_all_refuse_resume' };
}
