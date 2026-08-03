import Database from 'better-sqlite3';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface RawSample {
  t: string; size_bert: string; raydium_mid_usd: string; kraken_bid: string; kraken_ask: string;
  dex_sell_price_usd: string; dex_buy_price_usd: string; maker_fee_bps: number;
  buy_maker_edge_bps: string; sell_maker_edge_bps: string;
  dex_sell_impact_bps: string; dex_buy_impact_bps: string;
  book_age_ms: number; oracle_trusted: number;
}
interface RawPaperFill {
  paper_fill_id: string; side: string; volume_bert: string; gross_pnl_usd: string;
  maker_fee_usd: string; transaction_cost_usd: string; latency_cost_usd: string;
  failure_reserve_usd: string; net_pnl_usd: string; t: string;
}
interface RawCandidateFill {
  candidate_fill_id: string; side: string; distance_bps: string; volume_bert: string;
  gross_pnl_usd: string; normal_net_pnl_usd: string; stress_net_pnl_usd: string;
  hedge_status: string; economics_source: string; hedge_resolved_at: string | null;
  hedge_terminal_reason: string | null; t: string;
}
interface RawGatePeriod { gate: string; started_at: string; ended_at: string | null }
interface RawCloseReason { close_reason: string; n: number }

const dbPath = process.env['BERT_XEMM_DB'] ?? '/var/lib/bert-xemm-bot/state.db';
const outputPath = process.env['BERT_XEMM_DASHBOARD_JSON'] ?? '/var/www/drinkerlabs/bert-mm/data.json';
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const rows = db.prepare(`
  SELECT * FROM observer_samples WHERE t >= ? ORDER BY t DESC LIMIT 3000
`).all(since) as RawSample[];
const paperRows = db.prepare(`SELECT paper_fill_id,side,volume_bert,gross_pnl_usd,maker_fee_usd,
  transaction_cost_usd,latency_cost_usd,failure_reserve_usd,net_pnl_usd,t
  FROM paper_fills WHERE t >= ? ORDER BY t ASC`).all(since) as RawPaperFill[];
const openPaperOrders = (db.prepare(`SELECT COUNT(*) n FROM paper_orders WHERE status='open'`).get() as { n: number }).n;
const candidateRows = db.prepare(`SELECT candidate_fill_id,side,distance_bps,volume_bert,gross_pnl_usd,
  normal_net_pnl_usd,stress_net_pnl_usd,hedge_status,economics_source,
  hedge_resolved_at,hedge_terminal_reason,t
  FROM candidate_fills WHERE t >= ? ORDER BY t ASC`).all(since) as RawCandidateFill[];
const openCandidateOrders = (db.prepare(`SELECT COUNT(*) n FROM candidate_orders WHERE status='open'`).get() as { n: number }).n;
const publicTrades24h = (db.prepare(`SELECT COUNT(*) n FROM public_trades WHERE t >= ?`).get(since) as { n: number }).n;
const candidateSnapshots24h = (db.prepare(`SELECT COUNT(DISTINCT t) n FROM candidate_snapshots WHERE t >= ?`).get(since) as { n: number }).n;
const latestCandidateSnapshot = (db.prepare(`SELECT MAX(t) t FROM candidate_snapshots`).get() as { t: string | null }).t;
const gateRows = db.prepare(`SELECT gate,started_at,ended_at FROM candidate_gate_periods
  WHERE ended_at IS NULL OR ended_at >= ? OR started_at >= ? ORDER BY started_at ASC`).all(since, since) as RawGatePeriod[];
const closeReasons = db.prepare(`SELECT close_reason,COUNT(*) n FROM candidate_orders
  WHERE updated_at >= ? AND close_reason IS NOT NULL GROUP BY close_reason ORDER BY close_reason`).all(since) as RawCloseReason[];
db.close();

const samples = rows.map(r => ({
  t: r.t, sizeBert: Number(r.size_bert), raydiumMidUsd: Number(r.raydium_mid_usd),
  krakenBid: Number(r.kraken_bid), krakenAsk: Number(r.kraken_ask),
  dexSellPriceUsd: Number(r.dex_sell_price_usd), dexBuyPriceUsd: Number(r.dex_buy_price_usd),
  makerFeeBps: r.maker_fee_bps, buyMakerEdgeBps: Number(r.buy_maker_edge_bps),
  sellMakerEdgeBps: Number(r.sell_maker_edge_bps), dexSellImpactBps: Number(r.dex_sell_impact_bps),
  dexBuyImpactBps: Number(r.dex_buy_impact_bps), bookAgeMs: r.book_age_ms,
  oracleTrusted: r.oracle_trusted === 1,
}));
const trusted = samples.filter(s => s.oracleTrusted);
const sizes = [...new Set(samples.map(s => s.sizeBert))].sort((a, b) => a - b);
const bySize = sizes.map(sizeBert => {
  const xs = trusted.filter(s => s.sizeBert === sizeBert);
  const latest = xs[0] ?? null;
  return {
    sizeBert, latest,
    trustedSamples: xs.length,
    positiveBuyShare: share(xs, x => x.buyMakerEdgeBps > 0),
    positiveSellShare: share(xs, x => x.sellMakerEdgeBps > 0),
    medianBuyEdgeBps: median(xs.map(x => x.buyMakerEdgeBps)),
    medianSellEdgeBps: median(xs.map(x => x.sellMakerEdgeBps)),
  };
});
const latestT = samples[0]?.t ?? null;
let equity = 0, peak = 0, maxDrawdownUsd = 0;
const paperFills = paperRows.map(r => {
  const fill = { id:r.paper_fill_id, side:r.side, volumeBert:Number(r.volume_bert), grossPnlUsd:Number(r.gross_pnl_usd),
    makerFeeUsd:Number(r.maker_fee_usd), transactionCostUsd:Number(r.transaction_cost_usd), latencyCostUsd:Number(r.latency_cost_usd),
    failureReserveUsd:Number(r.failure_reserve_usd), netPnlUsd:Number(r.net_pnl_usd), t:r.t };
  equity += fill.netPnlUsd; peak = Math.max(peak, equity); maxDrawdownUsd = Math.max(maxDrawdownUsd, peak - equity);
  return { ...fill, cumulativePnlUsd: equity };
});
const sum = (key: keyof (typeof paperFills)[number]): number => paperFills.reduce((n, x) => n + Number(x[key]), 0);
const candidateFills = candidateRows.map(r => ({
  id: r.candidate_fill_id,
  side: r.side,
  distanceBps: Number(r.distance_bps),
  volumeBert: Number(r.volume_bert),
  grossPnlUsd: Number(r.gross_pnl_usd),
  normalNetPnlUsd: Number(r.normal_net_pnl_usd),
  stressNetPnlUsd: Number(r.stress_net_pnl_usd),
  hedgeStatus: r.hedge_status,
  economicsSource: r.economics_source,
  hedgeResolvedAt: r.hedge_resolved_at,
  hedgeTerminalReason: r.hedge_terminal_reason,
  t: r.t,
}));
const simulatedCandidateFills = candidateFills.filter(fill => fill.hedgeStatus === 'simulated');
const eligibleCandidateFills = simulatedCandidateFills.filter(fill => fill.economicsSource === 'fill_time_executable');
const candidateSum = (key: 'grossPnlUsd' | 'normalNetPnlUsd' | 'stressNetPnlUsd'): number =>
  eligibleCandidateFills.reduce((total, fill) => total + fill[key], 0);
const candidateDrawdowns = dualDrawdown(eligibleCandidateFills);
const nowMs = Date.now();
const gateSummary = [...new Set(gateRows.map(row => row.gate))].sort().map(gate => {
  const periods = gateRows.filter(row => row.gate === gate);
  return {
    gate,
    periods24h: periods.length,
    durationMs24h: periods.reduce((total, period) => {
      const start = Math.max(Date.parse(period.started_at), Date.parse(since));
      const end = Math.min(period.ended_at ? Date.parse(period.ended_at) : nowMs, nowMs);
      return total + Math.max(0, end - start);
    }, 0),
    active: periods.some(period => period.ended_at === null),
  };
});
const payload = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  mode: 'observer', funded: false, tradingEnabled: false,
  status: !latestT ? 'waiting' : Date.now() - Date.parse(latestT) <= 120_000 ? 'collecting' : 'stale',
  latestT,
  sampleCount24h: samples.length,
  trustedShare24h: samples.length ? trusted.length / samples.length : null,
  bySize,
  samples: samples.slice(0, 720).reverse(),
  paper: {
    openOrders: openPaperOrders, fills24h: paperFills.length,
    wins24h: paperFills.filter(x => x.netPnlUsd > 0).length,
    grossPnlUsd24h: sum('grossPnlUsd'), netPnlUsd24h: sum('netPnlUsd'),
    makerFeesUsd24h: sum('makerFeeUsd'), transactionCostsUsd24h: sum('transactionCostUsd'),
    latencyCostsUsd24h: sum('latencyCostUsd'), failureReserveUsd24h: sum('failureReserveUsd'),
    maxDrawdownUsd24h: maxDrawdownUsd, recentFills: paperFills.slice(-20).reverse(),
  },
  candidate: {
    latestSnapshotT: latestCandidateSnapshot,
    snapshots24h: candidateSnapshots24h,
    publicTrades24h,
    openOrders: openCandidateOrders,
    fills24h: candidateFills.length,
    simulatedFills24h: simulatedCandidateFills.length,
    eligibleFills24h: eligibleCandidateFills.length,
    restartRecoveredFills24h: simulatedCandidateFills.filter(fill => fill.economicsSource === 'restart_recovered_executable').length,
    pendingFills24h: candidateFills.filter(fill => fill.hedgeStatus === 'pending').length,
    abandonedFills24h: candidateFills.filter(fill => fill.hedgeStatus === 'abandoned').length,
    grossPnlUsd24h: candidateSum('grossPnlUsd'),
    normalNetPnlUsd24h: candidateSum('normalNetPnlUsd'),
    stressNetPnlUsd24h: candidateSum('stressNetPnlUsd'),
    normalMaxDrawdownUsd24h: candidateDrawdowns.normal,
    stressMaxDrawdownUsd24h: candidateDrawdowns.stress,
    closeReasons24h: Object.fromEntries(closeReasons.map(row => [row.close_reason, row.n])),
    activeGates: gateSummary.filter(gate => gate.active).map(gate => gate.gate),
    gateOutages24h: gateSummary,
    recentFills: candidateFills.slice(-20).reverse(),
  },
};
await mkdir(dirname(outputPath), { recursive: true });
const tmp = `${outputPath}.tmp`;
await writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
await rename(tmp, outputPath);

function share<T>(xs: T[], predicate: (x: T) => boolean): number | null {
  return xs.length ? xs.filter(predicate).length / xs.length : null;
}
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const ys = [...xs].sort((a, b) => a - b);
  const m = Math.floor(ys.length / 2);
  return ys.length % 2 ? ys[m]! : (ys[m - 1]! + ys[m]!) / 2;
}
function dualDrawdown(fills: Array<{ normalNetPnlUsd: number; stressNetPnlUsd: number }>): { normal: number; stress: number } {
  let normalEquity = 0, normalPeak = 0, normal = 0;
  let stressEquity = 0, stressPeak = 0, stress = 0;
  for (const fill of fills) {
    normalEquity += fill.normalNetPnlUsd;
    normalPeak = Math.max(normalPeak, normalEquity);
    normal = Math.max(normal, normalPeak - normalEquity);
    stressEquity += fill.stressNetPnlUsd;
    stressPeak = Math.max(stressPeak, stressEquity);
    stress = Math.max(stress, stressPeak - stressEquity);
  }
  return { normal, stress };
}
