import { writeFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { Reconciler } from './risk/reconciler.js';
import { HedgeExecutor } from './strategy/hedgeExecutor.js';
import { KillSwitchWatchdog, failClosedEvaluate } from './risk/killSwitchWatchdog.js';
import { createDegradedGate } from './risk/degradedGate.js';
import { sweepStaleHedges, STALE_HEDGE_MAX_AGE_MS } from './risk/hedgeSweeper.js';
import { QuoterLoop } from './orchestrator/quoterLoop.js';
import { FillLoop } from './orchestrator/fillLoop.js';
import { WatchdogLoop } from './orchestrator/watchdogLoop.js';
import { wireVenues } from './orchestrator/wire.js';
import Decimal from 'decimal.js';
import { BookCache } from './venues/bookCache.js';
import { NetDeltaTracker } from './strategy/netDeltaTracker.js';
import { trustedMid } from './priceOracle.js';
import { Raydium24hVol } from './venues/raydium24hVol.js';
import { PnlTracker } from './strategy/pnlTracker.js';
import { AdverseFillTracker } from './strategy/adverseFillTracker.js';
import { measureExecutableBuyExactOut, measureExecutableSell, measureObserverEconomics } from './observerEconomics.js';
import { PaperFillEngine, type PaperQuoteCandidate } from './paperFillEngine.js';
import { KrakenPublicTrades } from './venues/krakenPublicTrades.js';
import { CandidateFillEngine } from './candidateFillEngine.js';
import {
  measureCandidateSnapshot,
  type CandidateEconomicSnapshot,
} from './candidateQuoteSampler.js';
import {
  CANDIDATE_QUOTE_ATTEMPT_RETENTION_MS,
  CandidateCallAdmission,
  CandidateLaneGuard,
  candidateFingerprints,
  effectiveBaselineWatchdogMs,
  resolveCandidateApiKey,
} from './candidateRuntime.js';
import { jupiterQuote, JupiterQuoteHttpError } from './venues/jupiterApi.js';
import {
  condNetDelta, condKraken24hMin, condSolUsd1hMove, condStaleData,
  condRpcBurn, condRaydium24hMin, condDailyPnl, condAdverseFill,
} from './risk/conditions.js';

// Rolling 1h window of solUsd reads — feeds condSolUsd1hMove.
class SolUsdHistory {
  private readings: { t: number; price: number }[] = [];
  record(price: Decimal): void {
    const now = Date.now();
    this.readings.push({ t: now, price: price.toNumber() });
    const cutoff = now - 3_600_000;
    while (this.readings.length && this.readings[0]!.t < cutoff) this.readings.shift();
  }
  pctMove1h(): number {
    if (this.readings.length < 2) return 0;
    const first = this.readings[0]!.price;
    const last = this.readings[this.readings.length - 1]!.price;
    if (first === 0) return 0;
    return ((last - first) / first) * 100;
  }
}

// Cached Kraken 24h USD volume (pair vwap * base volume). Feeds condKraken24hMin.
class Kraken24hVol {
  private cache: { value: Decimal; at: number } | null = null;
  constructor(private pair: string, private ttlMs = 300_000) {}
  async fetch(): Promise<Decimal> {
    if (this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.value;
    try {
      const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${this.pair}`);
      if (!r.ok) throw new Error(`kraken ticker ${r.status}`);
      const j = await r.json() as { result?: Record<string, { v?: string[]; p?: string[] }> };
      const key = Object.keys(j.result ?? {})[0];
      const entry = key ? j.result?.[key] : undefined;
      const volBert = entry?.v?.[1] ?? '0';
      const vwap = entry?.p?.[1] ?? '0';
      const volUsd = new Decimal(volBert).mul(new Decimal(vwap));
      this.cache = { value: volUsd, at: Date.now() };
      return volUsd;
    } catch (err) {
      logger.warn({ err }, 'kraken 24h volume fetch failed; treating as 0');
      return new Decimal(0);
    }
  }
}

async function main(): Promise<void> {
  const { cfg, store, cex, dex, notifier, connection, rpcCounter } = wireVenues();
  logger.info({ mode: cfg.mode, enabled: cfg.enabled }, 'startup');

  const pruneCandidateAttemptTelemetry = (): void => {
    const beforeIso = new Date(Date.now() - CANDIDATE_QUOTE_ATTEMPT_RETENTION_MS).toISOString();
    const pruned = store.pruneCandidateQuoteAttempts(beforeIso);
    if (pruned > 0) logger.info({ pruned, beforeIso }, 'pruned expired candidate quote-attempt telemetry');
  };
  pruneCandidateAttemptTelemetry();
  const candidateTelemetryPruneTimer = setInterval(pruneCandidateAttemptTelemetry, 24 * 60 * 60 * 1000);

  // Quoting is gated on `degraded`, whose only durable home is sqlite. Wrap the store so a
  // failed flag write still stops the quoter via an in-process latch.
  const degradedGate = createDegradedGate(store);

  // Recovery sweep: any hedge row stuck non-terminal is counted as settled by the in-flight
  // sum, so bound how long that can lie — once at startup, then on a timer.
  const sweepHedges = (): void => {
    const swept = sweepStaleHedges({
      store,
      notifier: { page: (m) => { void notifier.critical(m); } },
      logger,
    });
    if (swept > 0) logger.error({ swept }, 'stale hedge sweep force-dead-lettered rows');
  };
  sweepHedges();

  const reconciler = new Reconciler({
    cex,
    store: {
      listOpenOrders: async () => store.listOpenOrders(),
      // Through the gate: a reconciler halt must survive a failed durable write too.
      setFlag: (k, v) => degradedGate.setFlag(k, v),
    },
    notifier: { page: (m) => { void notifier.critical(m); } },
  });
  if (cfg.mode === 'live') {
    const ok = await reconciler.run();
    if (!ok) { logger.error('reconciler refused startup'); process.exit(1); }
  }

  // HedgeExecutor wired against StateStore + Solana RPC txStatus adapter.
  // Spec section 5.5: poll getSignatureStatus every 2s up to 30s, then retry up to 3x.
  const hedgeExec = new HedgeExecutor({
    dex,
    store: {
      writeHedge: async (r) => { store.insertHedgeRow(r); },
      readInFlight: async () => store.sumInFlightHedgesBert(),
      markConfirmed: async (hedgeId, txSig, slippageRealized) => {
        store.markHedgeConfirmed(hedgeId, txSig, slippageRealized);
      },
    },
    notifier: { page: (m) => { void notifier.critical(m); } },
    maxDexSlippageBps: cfg.jupiter.maxSlippageBps,
    jitoTipLamports: 10_000,
    txStatus: async (sig) => {
      try {
        const r = await connection.getSignatureStatus(sig);
        const v = r.value;
        if (!v) return 'pending';
        if (v.err) return 'failed';
        if (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized') return 'confirmed';
        return 'pending';
      } catch (err) {
        logger.warn({ err, sig }, 'txStatus poll failed; treating as pending');
        return 'pending';
      }
    },
  });

  const tracker = new NetDeltaTracker();

  const bookCache = new BookCache(cfg.kraken.pair, logger);
  bookCache.run(cex, cfg.kraken.pair, 10).catch(e => logger.error({ err: e }, 'bookCache run crashed'));
  const publicTrades = new KrakenPublicTrades(cfg.kraken.cliBinaryPath, cfg.kraken.pair, logger);
  store.cancelAllOpenPaperOrders(new Date().toISOString(), 'process_restart');
  store.cancelAllOpenCandidateOrders(new Date().toISOString(), 'process_restart');
  const paper = new PaperFillEngine({
    minNetEdgeBps: cfg.paper.minNetEdgeBps,
    driftThresholdBps: cfg.quoter.driftThresholdBps,
    latencyPenaltyBps: cfg.paper.latencyPenaltyBps,
    failedHedgeReserveBps: cfg.paper.failedHedgeReserveBps,
    transactionCostUsd: cfg.paper.transactionCostUsd,
    store,
    hedgeAtFill: async (side, size, fillPrice) => {
      const mid = await dex.poolMidUsd();
      const fee = await cex.feeTier();
      const e = await measureObserverEconomics({
        sizeBert: size, krakenBid: fillPrice, krakenAsk: fillPrice,
        raydiumMidUsd: mid.mid, solUsd: mid.solUsd, makerFeeBps: fee.makerBps,
        jupiterBaseUrl: cfg.jupiter.baseUrl, slippageBps: cfg.jupiter.maxSlippageBps,
      });
      return {
        dexPriceUsd: side === 'buy' ? e.dexSellPriceUsd : e.dexBuyPriceUsd,
        makerFeeUsd: fillPrice.mul(size).mul(fee.makerBps).div(10_000),
        dexImpactBps: side === 'buy' ? e.dexSellImpactBps : e.dexBuyImpactBps,
      };
    },
  });
  const candidateFingerprint = candidateFingerprints(cfg.candidate, {
    jupiterMaxSlippageBps: cfg.jupiter.maxSlippageBps,
    observerSampleCadenceMs: cfg.observer.sampleCadenceMs,
  });
  const candidateStartup = resolveCandidateApiKey(cfg.candidate);
  if (cfg.mode === 'observer' && cfg.candidate.enabled && !candidateStartup.canStart) {
    logger.error(
      { apiKeyEnv: cfg.candidate.apiKeyEnv },
      'candidate lane refused startup: configured Jupiter API key is absent or empty; baseline remains active',
    );
  }

  let candidateSnapshot: CandidateEconomicSnapshot | null = null;
  let candidate: CandidateFillEngine | null = null;
  let candidateGuard: CandidateLaneGuard | null = null;
  let candidateAdmission: CandidateCallAdmission | null = null;
  let candidateQuote: typeof jupiterQuote | null = null;
  let recordCandidateAttempt: ((
    attemptKind: 'snapshot' | 'hedge',
    startedAtMs: number,
    requestedCallCount: number,
    providerStatus: 'success' | 'error' | 'http_429' | 'capacity_skipped',
    httpStatus: number | null,
    rateLimit429Count: number,
  ) => void) | null = null;
  let recordCandidateProviderFailure: ((
    err: unknown,
    startedAtMs: number,
    attemptKind: 'snapshot' | 'hedge',
    requestedCallCount: number,
  ) => void) | null = null;
  let candidateLatchRecorded = false;

  if (cfg.mode === 'observer' && candidateStartup.canStart && candidateStartup.apiKey !== null) {
    const activatedAt = new Date();
    const apiKey = candidateStartup.apiKey;
    const admission = new CandidateCallAdmission(cfg.candidate.maxQuoteCallsPerSec);
    candidateAdmission = admission;
    const authenticatedQuote: typeof jupiterQuote = (args) => jupiterQuote({ ...args, apiKey });
    candidateQuote = authenticatedQuote;
    const guard = new CandidateLaneGuard({
      disableOnProviderRateLimit: cfg.candidate.disableOnProviderRateLimit,
      providerRateLimitConsecutiveThreshold: cfg.candidate.providerRateLimitConsecutiveThreshold,
      providerRateLimitDefaultCooldownMs: cfg.candidate.providerRateLimitDefaultCooldownMs,
      baselineWatchdogMs: effectiveBaselineWatchdogMs(
        cfg.candidate.baselineWatchdogMs,
        cfg.observer.sampleCadenceMs,
      ),
    });
    candidateGuard = guard;

    const recordAttempt = (
      attemptKind: 'snapshot' | 'hedge',
      startedAtMs: number,
      requestedCallCount: number,
      providerStatus: 'success' | 'error' | 'http_429' | 'capacity_skipped',
      httpStatus: number | null,
      rateLimit429Count: number,
    ): void => {
      const completedAtMs = Date.now();
      store.insertCandidateQuoteAttempt({
        attemptKind,
        startedAt: new Date(startedAtMs).toISOString(),
        completedAt: new Date(completedAtMs).toISOString(),
        durationMs: Math.max(0, completedAtMs - startedAtMs),
        requestedCallCount,
        providerStatus,
        httpStatus,
        rateLimit429Count,
        baselineSampleAgeMs: guard.baselineSampleAgeMs(startedAtMs),
        economicFingerprint: candidateFingerprint.economicFingerprint,
        operationalFingerprint: candidateFingerprint.operationalFingerprint,
      });
    };

    const recordProviderFailure = (err: unknown, startedAtMs: number, attemptKind: 'snapshot' | 'hedge', requestedCallCount: number): void => {
      if (err instanceof JupiterQuoteHttpError) {
        const rateLimited = err.status === 429;
        recordAttempt(attemptKind, startedAtMs, requestedCallCount, rateLimited ? 'http_429' : 'error', err.status, rateLimited ? 1 : 0);
        if (rateLimited) guard.recordProviderRateLimit(err.rateLimitResetAtMs);
      } else {
        recordAttempt(attemptKind, startedAtMs, requestedCallCount, 'error', null, 0);
      }
    };
    recordCandidateAttempt = recordAttempt;
    recordCandidateProviderFailure = recordProviderFailure;

    const engine = new CandidateFillEngine({
      economicFingerprint: candidateFingerprint.economicFingerprint,
      operationalFingerprint: candidateFingerprint.operationalFingerprint,
      ladder: cfg.candidate.ladder,
        minAllInEdgeBps: cfg.candidate.minAllInEdgeBps,
        repriceThresholdBps: cfg.candidate.repriceThresholdBps,
        maxQuoteAgeMs: cfg.candidate.maxQuoteAgeMs,
        crossVenueMaxBps: cfg.candidate.crossVenueMaxBps,
        routeVsReserveMaxBps: cfg.candidate.routeVsReserveMaxBps,
        maxBookAgeSec: cfg.candidate.maxBookAgeSec,
        drift5sBps: cfg.candidate.drift5sBps,
        drift30sBps: cfg.candidate.drift30sBps,
        driftResumeStableSec: cfg.candidate.driftResumeStableSec,
        maxPendingHedgeAgeMs: cfg.candidate.maxPendingHedgeAgeMs,
        maxActivePerSideBert: cfg.candidate.maxActivePerSideBert,
        normalFriction: cfg.candidate.normalFriction,
        stressFriction: cfg.candidate.stressFriction,
        store,
        hedgeBatch: async (side, sizeBert) => {
          const startedAtMs = Date.now();
          if (!guard.canAttemptProvider(startedAtMs) || !admission.tryAdmit(1, startedAtMs)) {
            recordAttempt('hedge', startedAtMs, 1, 'capacity_skipped', null, 0);
            throw new Error('candidate hedge quote capacity unavailable');
          }
          try {
            const mid = await dex.poolMidUsd();
            const input = {
              sizeBert,
              raydiumMidUsd: mid.mid,
              solUsd: mid.solUsd,
              jupiterBaseUrl: cfg.candidate.jupiterBaseUrl,
              slippageBps: cfg.jupiter.maxSlippageBps,
              quote: authenticatedQuote,
            };
            const executable = side === 'buy'
              ? await measureExecutableSell(input)
              : await measureExecutableBuyExactOut(input);
            recordAttempt('hedge', startedAtMs, 1, 'success', 200, 0);
            return { dexPriceUsd: executable.priceUsd, dexImpactBps: executable.impactBps };
          } catch (err) {
            recordProviderFailure(err, startedAtMs, 'hedge', 1);
            throw err;
          }
      },
    });
    candidate = engine;
    guard.setOnStateChange(() => {
      engine.setExternalGates(guard.activeGates());
      engine.updateQuotes(candidateSnapshot, new Date());
      if (guard.isLatched() && !candidateLatchRecorded) {
        candidateLatchRecorded = true;
        const reason = guard.latchedReason() ?? 'unknown';
        store.latchCandidateRuntime(reason, new Date().toISOString());
        logger.error(
          { reason, total429s: guard.total429Count() },
          'CANDIDATE LANE LATCHED OFF FOR PROCESS LIFETIME; baseline remains active',
        );
      }
    });
    store.setCandidateRuntimeState(
      candidateFingerprint.economicFingerprint,
      candidateFingerprint.operationalFingerprint,
      activatedAt.toISOString(),
    );
    logger.info(
      {
        economicFingerprint: candidateFingerprint.economicFingerprint,
        operationalFingerprint: candidateFingerprint.operationalFingerprint,
        jupiterBaseUrl: cfg.candidate.jupiterBaseUrl,
        maxQuoteCallsPerSec: cfg.candidate.maxQuoteCallsPerSec,
      },
      'candidate lane ready with keyed Jupiter endpoint',
    );
  }
  candidate?.restorePendingFills(store.listPendingCandidateFills());
  if (candidate) {
    publicTrades.onBatch(trades => {
      store.insertPublicTrades(trades);
      return candidate.onTradeBatch(trades);
    });
  }
  if (cfg.paper.enabled) publicTrades.onTrade(t => paper.onTrade(t));
  if (cfg.mode === 'observer' && (cfg.paper.enabled || candidate !== null)) {
    publicTrades.run().catch(e => logger.error({ err: e }, 'public trades stream crashed'));
  }

  const solUsdHist = new SolUsdHistory();
  const kraken24h = new Kraken24hVol(cfg.kraken.pair);
  const raydium24h = new Raydium24hVol({ poolAddress: cfg.raydium.poolAddress, logger });

  const pnl = new PnlTracker();
  const adverseFill = new AdverseFillTracker({
    postFillDelayMs: 5 * 60_000,
    getMidUsd: async () => (await dex.poolMidUsd()).mid,
  });

  // Bootstrap pnl day-start once we have inventory.
  void (async () => {
    try {
      const mid = await dex.poolMidUsd();
      const balances = await cex.balances();
      const dexBal = await dex.walletBalances();
      const inv = tracker.snapshot({
        kraken: balances, dex: dexBal,
        inFlightHedgesBert: store.sumInFlightHedgesBert(),
        midUsd: mid.mid,
      });
      pnl.initDayStart(inv.bertNet, mid.mid, balances.quote, new Date());
    } catch (err) {
      logger.warn({ err }, 'pnl day-start bootstrap failed; using zeros');
    }
  })();

  const evaluateConditions = failClosedEvaluate(
    async (out) => {
      const mid = await dex.poolMidUsd();
      solUsdHist.record(mid.solUsd);
      const balances = await cex.balances();
      const dexBal = await dex.walletBalances();
      const inv = tracker.snapshot({
        kraken: balances, dex: dexBal,
        inFlightHedgesBert: store.sumInFlightHedgesBert(), midUsd: mid.mid,
      });

      out.push(condNetDelta({ usdNet: inv.usdNet }, { netDeltaUsd: cfg.watchdog.conditions.netDeltaUsd }));

      const kVol = await kraken24h.fetch();
      out.push(condKraken24hMin({ kraken24hVolUsd: kVol }, { kraken24hMinUsd: cfg.watchdog.conditions.kraken24hMinUsd }));

      out.push(condSolUsd1hMove({ pctMove1h: solUsdHist.pctMove1h() }, { solUsd1hMaxAbsPct: cfg.watchdog.conditions.solUsd1hMaxAbsPct }));

      const ageSec = (Date.now() - mid.asOf.getTime()) / 1000;
      out.push(condStaleData({ oldestSourceAgeSec: ageSec }, { staleDataSeconds: cfg.watchdog.conditions.staleDataSeconds }));

      out.push(condRpcBurn(
        { callsPerMin: rpcCounter.callsPerMin() },
        { rpcCallsPerMinHalt: cfg.watchdog.conditions.rpcCallsPerMinHalt },
      ));

      const rayVol = await raydium24h.fetch();
      out.push(condRaydium24hMin(
        { raydium24hVolUsd: rayVol },
        { raydium24hMinUsd: cfg.watchdog.conditions.raydium24hMinUsd },
      ));

      const pnlSnap = pnl.snapshot(inv.bertNet, mid.mid, new Date());
      out.push(condDailyPnl(
        { pnlPct: pnlSnap.totalPct },
        { dailyPnlPct: cfg.watchdog.conditions.dailyPnlPct },
      ));

      out.push(condAdverseFill(
        { adverseShareLast20: adverseFill.adverseShareLast20() },
        { adverseFillRateMax: cfg.watchdog.conditions.adverseFillRateMax },
      ));

      // 8 of 8 conditions now wired.
    },
    (err) => logger.error({ err }, 'watchdog evaluate failed; failing closed (synthetic kill)'),
  );

  const watchdog = new KillSwitchWatchdog({
    store: {
      setFlag: (k, v) => degradedGate.setFlag(k, v),
      insertKillEvent: (r) => store.insertKillEvent(r),
      latchDegraded: () => degradedGate.latchDegraded(),
    },
    cex,
    notifier: {
      page: (m) => { void notifier.critical(m); },
      warn: (m) => { void notifier.warn(m); },
    },
    evaluate: evaluateConditions,
    logger,
  });

  const quoter = new QuoterLoop({
    cex,
    store: {
      insertBasisSample: (r) => store.insertBasisSample(r),
      insertOrder: (r) => store.insertOrder(r),
      // Reads through the latch, so a kill halts quoting even if the flag write failed.
      getFlag: (k) => degradedGate.getFlag(k),
    },
    executeIntents: cfg.mode === 'live',
    readInputs: async () => {
      const mid = await dex.poolMidUsd();
      const book = bookCache.snapshot();
      const topBid = book.bids[0]?.price;
      const topAsk = book.asks[0]?.price;
      const krakenMid = topBid && topAsk ? topBid.plus(topAsk).div(2) : null;
      const trust = trustedMid({
        samples: krakenMid ? [
          { source: 'raydium', midUsd: mid.mid.toString() },
          { source: 'kraken', midUsd: krakenMid.toString() },
        ] : [{ source: 'raydium', midUsd: mid.mid.toString() }],
        maxDivergenceBps: cfg.oracleDivergenceBps,
      });
      const balances = await cex.balances();
      const dexBal = await dex.walletBalances();
      const snap = tracker.snapshot({
        kraken: balances, dex: dexBal,
        inFlightHedgesBert: store.sumInFlightHedgesBert(), midUsd: mid.mid,
      });
      const fee = await cex.feeTier();
      return {
        ref: { raydiumMidUsd: mid.mid, solUsd: mid.solUsd, asOf: mid.asOf },
        oracleTrusted: trust.trusted,
        krakenBook: book,
        openOrders: await cex.openOrders(),
        inventory: snap,
        feeTier: fee,
        dexCostBps: 35,
        config: {
          bufferBps: cfg.quoter.bufferBps,
          driftThresholdBps: cfg.quoter.driftThresholdBps,
          inventorySkewBpsPerUsd: cfg.quoter.inventorySkewBpsPerUsd,
          minEdgeBps: cfg.quoter.minEdgeBps,
          maxInventoryUsd: cfg.inventory.maxNetUsd,
          defaultVolumeBert: new Decimal('1000'),
        },
      };
    },
    logger,
  });

  const fillLoop = new FillLoop(
    cex, hedgeExec, logger,
    async () => (await dex.poolMidUsd()).solUsd,
    (f) => { pnl.recordFill(f); adverseFill.recordFill(f); },
  );
  const wdLoop = new WatchdogLoop(watchdog, cfg.watchdog.cadenceMs, logger);

  const quoterTimer = setInterval(() => {
    quoter.tick().catch(e => logger.error({ err: e }, 'quoter tick'));
  }, cfg.quoter.cadenceMs);

  const hedgeSweepTimer = setInterval(sweepHedges, STALE_HEDGE_MAX_AGE_MS);

  const observerTick = async (): Promise<void> => {
    candidateGuard?.recordBaselineAttempt();
    const book = bookCache.snapshot();
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    if (!bid || !ask) {
      if (cfg.paper.enabled) paper.updateQuotes([]);
      logger.warn('observer: waiting for complete Kraken book'); return;
    }
    const mid = await dex.poolMidUsd();
    const bookAgeMs = Math.max(0, Date.now() - book.t.getTime());
    const crossVenueTrust = trustedMid({
      samples: [
        { source: 'raydium', midUsd: mid.mid.toString() },
        { source: 'kraken', midUsd: bid.plus(ask).div(2).toString() },
      ],
      maxDivergenceBps: cfg.oracleDivergenceBps,
    });
    const oracleTrusted = crossVenueTrust.trusted && bookAgeMs <= cfg.observer.maxBookAgeSec * 1000;
    const fee = await cex.feeTier();
    const paperCandidates: PaperQuoteCandidate[] = [];
    for (const rawSize of cfg.observer.sizesBert) {
      try {
        const sizeBert = new Decimal(rawSize);
        const e = await measureObserverEconomics({
          sizeBert, krakenBid: bid, krakenAsk: ask, raydiumMidUsd: mid.mid,
          solUsd: mid.solUsd, makerFeeBps: fee.makerBps,
          jupiterBaseUrl: cfg.jupiter.baseUrl, slippageBps: cfg.jupiter.maxSlippageBps,
        });
        store.insertObserverSample({
          t: new Date().toISOString(), sizeBert: sizeBert.toString(),
          raydiumMidUsd: mid.mid.toString(), krakenBid: bid.toString(), krakenAsk: ask.toString(),
          dexSellPriceUsd: e.dexSellPriceUsd.toString(), dexBuyPriceUsd: e.dexBuyPriceUsd.toString(),
          makerFeeBps: fee.makerBps, buyMakerEdgeBps: e.buyMakerEdgeBps.toString(),
          sellMakerEdgeBps: e.sellMakerEdgeBps.toString(), dexSellImpactBps: e.dexSellImpactBps.toString(),
          dexBuyImpactBps: e.dexBuyImpactBps.toString(), bookAgeMs, oracleTrusted,
        });
        candidateGuard?.recordBaselineSuccess();
        const fixedCostBps = sizeBert.mul(mid.mid).gt(0)
          ? new Decimal(cfg.paper.transactionCostUsd).div(sizeBert.mul(mid.mid)).mul(10_000)
          : new Decimal(0);
        const requiredBps = new Decimal(fee.makerBps + cfg.paper.minNetEdgeBps + cfg.paper.latencyPenaltyBps + cfg.paper.failedHedgeReserveBps).plus(fixedCostBps);
        paperCandidates.push({
          sizeBert, side: 'buy', price: e.dexSellPriceUsd.div(new Decimal(1).plus(requiredBps.div(10_000))),
          expectedEdgeBps: new Decimal(cfg.paper.minNetEdgeBps), book, oracleTrusted,
        });
        paperCandidates.push({
          sizeBert, side: 'sell', price: e.dexBuyPriceUsd.mul(new Decimal(1).plus(requiredBps.div(10_000))),
          expectedEdgeBps: new Decimal(cfg.paper.minNetEdgeBps), book, oracleTrusted,
        });
        logger.info({ sizeBert: rawSize, buyEdgeBps: e.buyMakerEdgeBps.toFixed(1), sellEdgeBps: e.sellMakerEdgeBps.toFixed(1), oracleTrusted }, 'observer: executable edge sampled');
      } catch (err) {
        logger.warn({ err, sizeBert: rawSize }, 'observer: executable quote sample failed');
      }
    }
    if (cfg.paper.enabled) paper.updateQuotes(paperCandidates);
  };
  let observerTimer: NodeJS.Timeout | undefined;
  if (cfg.mode === 'observer') {
    observerTimer = setInterval(() => void observerTick().catch(err => logger.error({ err }, 'observer tick')), cfg.observer.sampleCadenceMs);
    void observerTick().catch(err => logger.error({ err }, 'observer initial tick'));
  }

  let candidateTimer: NodeJS.Timeout | undefined;
  let candidateRefreshInFlight = false;
  const candidateSnapshotCallCount = new Set(cfg.candidate.ladder.map(rung => String(rung.sizeBert))).size * 2;
  const refreshCandidateSnapshot = async (): Promise<void> => {
    if (!candidate || !candidateGuard || !candidateAdmission || !candidateQuote
      || !recordCandidateAttempt || !recordCandidateProviderFailure || candidateRefreshInFlight) return;
    const startedAtMs = Date.now();
    if (!candidateGuard.canAttemptProvider(startedAtMs)) return;
    if (!candidateAdmission.tryAdmit(candidateSnapshotCallCount, startedAtMs)) {
      recordCandidateAttempt('snapshot', startedAtMs, candidateSnapshotCallCount, 'capacity_skipped', null, 0);
      return;
    }
    candidateRefreshInFlight = true;
    try {
      const book = bookCache.snapshot();
      if (!book.bids[0] || !book.asks[0]) throw new Error('waiting for complete Kraken book');
      const mid = await dex.poolMidUsd();
      const snapshot = await measureCandidateSnapshot({
        sizesBert: cfg.candidate.ladder.map(rung => new Decimal(rung.sizeBert)),
        raydiumMidUsd: mid.mid,
        solUsd: mid.solUsd,
        book,
        jupiterBaseUrl: cfg.candidate.jupiterBaseUrl,
        slippageBps: cfg.jupiter.maxSlippageBps,
        quote: candidateQuote,
      });
      candidateSnapshot = snapshot;
      candidate.recordRefreshSuccess();
      store.insertCandidateSnapshot(
        snapshot,
        candidateFingerprint.economicFingerprint,
        candidateFingerprint.operationalFingerprint,
      );
      recordCandidateAttempt('snapshot', startedAtMs, candidateSnapshotCallCount, 'success', 200, 0);
      candidateGuard.recordSnapshotSuccess();
    } catch (err) {
      candidate.recordRefreshFailure();
      recordCandidateProviderFailure(err, startedAtMs, 'snapshot', candidateSnapshotCallCount);
      if (err instanceof JupiterQuoteHttpError && err.status === 429) {
        logger.error(
          {
            consecutive429s: candidateGuard.consecutive429Count(),
            total429s: candidateGuard.total429Count(),
            latched: candidateGuard.isLatched(),
          },
          'candidate: Jupiter provider rate limit; quotes pulled and cooldown engaged',
        );
      } else {
        logger.warn({ err }, 'candidate: complete executable snapshot refresh failed');
      }
    } finally {
      candidateRefreshInFlight = false;
    }
  };
  const candidateTick = (): void => {
    if (!candidate || !candidateGuard) return;
    candidateGuard.checkBaselineWatchdog();
    candidate.updateQuotes(candidateSnapshot, new Date());
    if (candidateGuard.isLatched()) return;
    if (candidate.hasPendingHedge()) {
      void candidate.retryPendingHedges().catch(err => logger.warn({ err }, 'candidate: simulated hedge retry failed'));
    }
    void refreshCandidateSnapshot();
  };
  if (candidate) {
    candidateTimer = setInterval(candidateTick, cfg.candidate.decisionCadenceMs);
    candidateTick();
  }

  // Heartbeat ticker — touches the file every 5s so ops/heartbeat-check.sh sees
  // a fresh mtime. Independent of the three main loops so any one of them
  // hanging still surfaces as a heartbeat-stale alert at the next 5s tick.
  const heartbeatTimer = setInterval(() => {
    writeFile(cfg.paths.heartbeat, new Date().toISOString())
      .catch(err => logger.warn({ err }, 'heartbeat write failed'));
  }, 5_000);

  if (cfg.mode !== 'observer') {
    fillLoop.run().catch(e => logger.error({ err: e }, 'fillLoop crashed'));
  }
  if (cfg.mode === 'live') wdLoop.start();

  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down');
    clearInterval(quoterTimer);
    clearInterval(hedgeSweepTimer);
    clearInterval(heartbeatTimer);
    clearInterval(candidateTelemetryPruneTimer);
    if (observerTimer) clearInterval(observerTimer);
    if (candidateTimer) clearInterval(candidateTimer);
    wdLoop.stop();
    fillLoop.shutdown();
    bookCache.shutdown();
    publicTrades.shutdown();
    adverseFill.shutdown();
    process.exit(0);
  });
}

main().catch(e => { logger.error({ err: e }, 'fatal'); process.exit(1); });
