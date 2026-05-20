import { writeFile } from 'node:fs/promises';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { StateStore } from './stateStore.js';
import { Connection } from '@solana/web3.js';
import { KrakenClient } from './venues/krakenClient.js';
import { KrakenPaper } from './venues/krakenPaper.js';
import { RaydiumAmmClient, type RpcAdapter, type SolRefAdapter } from './venues/raydiumAmmClient.js';
import { JitoClient } from './jitoClient.js';
import { TxSubmitter } from './txSubmitter.js';
import { Reconciler } from './risk/reconciler.js';
import { HedgeExecutor } from './strategy/hedgeExecutor.js';
import { KillSwitchWatchdog } from './risk/killSwitchWatchdog.js';
import { QuoterLoop } from './orchestrator/quoterLoop.js';
import { FillLoop } from './orchestrator/fillLoop.js';
import { WatchdogLoop } from './orchestrator/watchdogLoop.js';
import { Notifier } from './notifier.js';
import Decimal from 'decimal.js';
import { NetDeltaTracker } from './strategy/netDeltaTracker.js';
import { trustedMid } from './priceOracle.js';

async function main(): Promise<void> {
  const cfg = loadConfig(process.env['CONFIG_PATH'] ?? '/etc/bert-xemm-bot/config.yaml');
  logger.info({ mode: cfg.mode, enabled: cfg.enabled }, 'startup');

  const store = new StateStore(cfg.paths.state);

  const notifierOpts: ConstructorParameters<typeof Notifier>[0] = {
    logger,
  };
  if (cfg.notifier.discordWebhookUrl) notifierOpts.discordWebhookUrl = cfg.notifier.discordWebhookUrl;
  if (cfg.notifier.telegram) {
    notifierOpts.telegram = {
      botToken: process.env[cfg.notifier.telegram.botTokenEnv] ?? '',
      chatId: cfg.notifier.telegram.chatId,
    };
  }
  const notifier = new Notifier(notifierOpts);

  const cex = cfg.mode === 'paper'
    ? new KrakenPaper({ cliBinaryPath: cfg.kraken.cliBinaryPath, pair: cfg.kraken.pair })
    : new KrakenClient({
        cliBinaryPath: cfg.kraken.cliBinaryPath, pair: cfg.kraken.pair,
        apiKeyEnv: cfg.kraken.apiKeyEnv, apiSecretEnv: cfg.kraken.apiSecretEnv, paper: false,
      });

  const connection = new Connection(cfg.raydium.rpcUrl, 'confirmed');
  const jito = new JitoClient({ blockEngineUrl: cfg.raydium.jitoBlockEngine });
  // signer: real implementations load the hot wallet keyfile. For Phase 1 observer / Phase 2 paper, a no-op signer is fine.
  const signer = { sign: async <T>(tx: T): Promise<T> => tx };
  const submitter = new TxSubmitter({ connection, jito, signer: signer as never });

  // Minimal RPC adapter — Phase 1/2 stub. Real implementation will use @solana/web3.js calls.
  const rpc: RpcAdapter = {
    async getPoolState(_pool) { return { baseVault: 'BV', quoteVault: 'QV', baseDecimals: 6, quoteDecimals: 9 }; },
    async getTokenBalance(_acct) { return { uiAmount: '0', amount: '0', decimals: 6 }; },
    async getWalletBalances() { return { bert: '0', sol: '0' }; },
  };
  const solRef: SolRefAdapter = { async fetchSolUsd() { return '86.12'; } };
  const dex = new RaydiumAmmClient(
    { poolAddress: cfg.raydium.poolAddress, rpcUrl: cfg.raydium.rpcUrl, jitoBlockEngine: cfg.raydium.jitoBlockEngine },
    rpc, solRef, submitter, '', cfg.jupiter.baseUrl, cfg.jupiter.maxSlippageBps,
  );

  const reconciler = new Reconciler({
    cex,
    store: {
      listOpenOrders: async () => [],
      setFlag: (k, v) => store.setFlag(k, v),
    },
    notifier: { page: (m) => { void notifier.critical(m); } },
  });
  const ok = await reconciler.run();
  if (!ok) { logger.error('reconciler refused startup'); process.exit(1); }

  // HedgeExecutor v1 persistence stub: logger-only hedge state. Full schema in Task 25.
  const hedgeExec = new HedgeExecutor({
    dex,
    store: {
      writeHedge: async (r) => { logger.info({ hedge: r }, 'hedge state'); },
      readInFlight: async () => new Decimal('0'),
      markConfirmed: async () => { /* persistence stub for v1 */ },
    },
    notifier: { page: (m) => { void notifier.critical(m); } },
    maxDexSlippageBps: cfg.jupiter.maxSlippageBps,
    jitoTipLamports: 10_000,
  });

  const watchdog = new KillSwitchWatchdog({
    store: {
      setFlag: (k, v) => store.setFlag(k, v),
      insertKillEvent: () => { /* persistence stub for v1; full schema in Task 25 read queries */ },
    },
    cex,
    notifier: {
      page: (m) => { void notifier.critical(m); },
      warn: (m) => { void notifier.warn(m); },
    },
    evaluate: async () => [],
  });

  const tracker = new NetDeltaTracker();
  const quoter = new QuoterLoop({
    cex, store,
    readInputs: async () => {
      const mid = await dex.poolMidUsd();
      const trust = trustedMid({
        samples: [
          { source: 'raydium', midUsd: mid.mid.toString() },
          { source: 'jupiter', midUsd: mid.mid.toString() },
        ],
        maxDivergenceBps: cfg.oracleDivergenceBps,
      });
      const balances = await cex.balances();
      const dexBal = await dex.walletBalances();
      const snap = tracker.snapshot({
        kraken: balances, dex: dexBal,
        inFlightHedgesBert: new Decimal('0'), midUsd: mid.mid,
      });
      const fee = await cex.feeTier();
      return {
        ref: { raydiumMidUsd: mid.mid, solUsd: mid.solUsd, asOf: mid.asOf },
        oracleTrusted: trust.trusted,
        krakenBook: { pair: cfg.kraken.pair, bids: [], asks: [], t: new Date() },
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

  const fillLoop = new FillLoop(cex, hedgeExec, logger);
  const wdLoop = new WatchdogLoop(watchdog, cfg.watchdog.cadenceMs, logger);

  // Observer mode must NEVER place orders. Override CEX placeLimit at runtime so the
  // quoter can still compute intents and log them via basis_samples, but never submit.
  if (cfg.mode === 'observer') {
    const origPlace = cex.placeLimit.bind(cex);
    cex.placeLimit = async (_p) => {
      logger.info({ mode: 'observer' }, 'placeLimit suppressed in observer mode');
      return 'OBSERVER-NO-OP';
    };
    void origPlace; // retained for symmetry; never used while mode === observer
  }

  const quoterTimer = setInterval(() => {
    quoter.tick().catch(e => logger.error({ err: e }, 'quoter tick'));
  }, cfg.quoter.cadenceMs);

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
  wdLoop.start();

  process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down');
    clearInterval(quoterTimer);
    clearInterval(heartbeatTimer);
    wdLoop.stop();
    fillLoop.shutdown();
    process.exit(0);
  });
}

main().catch(e => { logger.error({ err: e }, 'fatal'); process.exit(1); });
