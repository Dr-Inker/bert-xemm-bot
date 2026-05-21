import { Connection } from '@solana/web3.js';
import { loadConfig, type BotConfig } from '../config.js';
import { logger } from '../logger.js';
import { StateStore } from '../stateStore.js';
import { KrakenClient } from '../venues/krakenClient.js';
import { KrakenPaper } from '../venues/krakenPaper.js';
import { RaydiumAmmClient } from '../venues/raydiumAmmClient.js';
import { SolanaRpcAdapter } from '../venues/solanaRpcAdapter.js';
import { JupiterSolRef } from '../venues/solRefAdapter.js';
import { JitoClient } from '../jitoClient.js';
import { TxSubmitter } from '../txSubmitter.js';
import { Notifier } from '../notifier.js';
import type { HedgeVenue } from '../venues/hedgeVenue.js';
import type { DexVenue } from '../venues/dexVenue.js';

export const BERT_MINT = 'HgBRWfYxEfvPhtqkaeymCQtHCrKE46qQ43pKe8HCpump';

export interface WiredVenues {
  cfg: BotConfig;
  store: StateStore;
  cex: HedgeVenue;
  dex: DexVenue;
  notifier: Notifier;
  connection: Connection;
}

export function wireVenues(configPath?: string): WiredVenues {
  const cfg = loadConfig(configPath ?? process.env['CONFIG_PATH'] ?? '/etc/bert-xemm-bot/config.yaml');
  const store = new StateStore(cfg.paths.state);

  const notifierOpts: ConstructorParameters<typeof Notifier>[0] = { logger };
  if (cfg.notifier.discordWebhookUrl) notifierOpts.discordWebhookUrl = cfg.notifier.discordWebhookUrl;
  if (cfg.notifier.telegram) {
    notifierOpts.telegram = {
      botToken: process.env[cfg.notifier.telegram.botTokenEnv] ?? '',
      chatId: cfg.notifier.telegram.chatId,
    };
  }
  const notifier = new Notifier(notifierOpts);

  const cex: HedgeVenue = cfg.mode === 'paper'
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

  const rpc = new SolanaRpcAdapter({
    connection, poolAddress: cfg.raydium.poolAddress, bertMint: BERT_MINT,
    // hotWalletPubkey: undefined for now — Phase 3 reads the keyfile. Wallet zeros are OK for observer/paper.
  });
  const solRef = new JupiterSolRef();
  const dex: DexVenue = new RaydiumAmmClient(
    { poolAddress: cfg.raydium.poolAddress, rpcUrl: cfg.raydium.rpcUrl, jitoBlockEngine: cfg.raydium.jitoBlockEngine },
    rpc, solRef, submitter, '', cfg.jupiter.baseUrl, cfg.jupiter.maxSlippageBps,
  );

  return { cfg, store, cex, dex, notifier, connection };
}
