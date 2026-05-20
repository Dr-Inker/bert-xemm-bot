import { loadConfig } from '../src/config.js';
import { KrakenClient } from '../src/venues/krakenClient.js';
import { logger } from '../src/logger.js';

const cfgPath = process.argv[2] ?? '/etc/bert-xemm-bot/config.yaml';
const cfg = loadConfig(cfgPath);

const c = new KrakenClient({
  cliBinaryPath: cfg.kraken.cliBinaryPath,
  pair: cfg.kraken.pair,
  apiKeyEnv: cfg.kraken.apiKeyEnv,
  apiSecretEnv: cfg.kraken.apiSecretEnv,
  paper: cfg.mode === 'paper',
});

const r = await c.cancelAll();
logger.info({ cancelled: r.cancelled }, 'kraken cancel-all complete');
