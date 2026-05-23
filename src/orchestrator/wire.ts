import { Connection, VersionedTransaction } from '@solana/web3.js';
import { loadConfig, type BotConfig } from '../config.js';
import { logger } from '../logger.js';
import { StateStore } from '../stateStore.js';
import { KrakenClient } from '../venues/krakenClient.js';
import { KrakenObserver } from '../venues/krakenObserver.js';
import { RaydiumAmmClient } from '../venues/raydiumAmmClient.js';
import { SolanaRpcAdapter } from '../venues/solanaRpcAdapter.js';
import { JupiterSolRef } from '../venues/solRefAdapter.js';
import { JitoClient } from '../jitoClient.js';
import { TxSubmitter, type TxSubmitterDeps } from '../txSubmitter.js';
import { Notifier } from '../notifier.js';
import { RpcCounter } from '../utils/rpcCounter.js';
import { loadHotWallet } from '../utils/hotWallet.js';
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
  rpcCounter: RpcCounter;
}

function buildSigner(cfg: BotConfig): { signer: TxSubmitterDeps['signer']; hotWalletPubkey: string } {
  if (cfg.mode !== 'live') {
    return {
      hotWalletPubkey: '',
      signer: { sign: async <T>(tx: T): Promise<T> => tx },
    };
  }

  const kp = loadHotWallet(cfg.paths.keyfile);
  logger.info({ pubkey: kp.publicKey.toBase58() }, 'loaded hot wallet for live mode');
  return {
    hotWalletPubkey: kp.publicKey.toBase58(),
    signer: {
      sign: async (tx: VersionedTransaction): Promise<VersionedTransaction> => {
        tx.sign([kp]);
        return tx;
      },
    },
  };
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

  const cex: HedgeVenue = cfg.mode === 'observer'
    ? new KrakenObserver({ cliBinaryPath: cfg.kraken.cliBinaryPath, pair: cfg.kraken.pair })
    : new KrakenClient({
        cliBinaryPath: cfg.kraken.cliBinaryPath, pair: cfg.kraken.pair,
        apiKeyEnv: cfg.kraken.apiKeyEnv, apiSecretEnv: cfg.kraken.apiSecretEnv, paper: false,
      });

  const connection = new Connection(cfg.raydium.rpcUrl, 'confirmed');
  const jito = new JitoClient({ blockEngineUrl: cfg.raydium.jitoBlockEngine });
  const { signer, hotWalletPubkey } = buildSigner(cfg);
  const submitter = new TxSubmitter({ connection, jito, signer });

  const rpcCounter = new RpcCounter();
  const rpcOpts: ConstructorParameters<typeof SolanaRpcAdapter>[0] = {
    connection, poolAddress: cfg.raydium.poolAddress, bertMint: BERT_MINT, rpcCounter,
  };
  if (hotWalletPubkey) rpcOpts.hotWalletPubkey = hotWalletPubkey;
  const rpc = new SolanaRpcAdapter(rpcOpts);
  const solRef = new JupiterSolRef();
  const raydium = new RaydiumAmmClient(
    { poolAddress: cfg.raydium.poolAddress, rpcUrl: cfg.raydium.rpcUrl, jitoBlockEngine: cfg.raydium.jitoBlockEngine },
    rpc, solRef, submitter, hotWalletPubkey, cfg.jupiter.baseUrl, cfg.jupiter.maxSlippageBps,
  );
  const dex: DexVenue = raydium;

  return { cfg, store, cex, dex, notifier, connection, rpcCounter };
}
