import { describe, it, expect } from 'vitest';
import { loadConfig, BotConfigSchema, type BotConfig } from '../src/config.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VALID_YAML = `
mode: observer
enabled: true
kraken:
  pair: BERTUSD
  cliBinaryPath: /usr/local/bin/kraken
  apiKeyEnv: KRAKEN_API_KEY
  apiSecretEnv: KRAKEN_API_SECRET
  feeTierRefreshSec: 3600
raydium:
  poolAddress: BmsZE6TkZYskyS1PatPKRyyazGdxWFxdia4BuvLg9AgY
  rpcUrl: https://api.mainnet-beta.solana.com
  jitoBlockEngine: mainnet.block-engine.jito.wtf
jupiter:
  baseUrl: https://lite-api.jup.ag/swap/v1
  maxSlippageBps: 50
quoter:
  cadenceMs: 2500
  bufferBps: 80
  driftThresholdBps: 15
  inventorySkewBpsPerUsd: 0.05
  minEdgeBps: 50
inventory:
  maxNetUsd: 500
watchdog:
  cadenceMs: 5000
  conditions:
    netDeltaUsd: 500
    dailyPnlPct: -2
    raydium24hMinUsd: 20000
    kraken24hMinUsd: 20000
    solUsd1hMaxAbsPct: 5
    rpcCallsPerMinHalt: 120
    adverseFillRateMax: 0.8
    staleDataSeconds: 30
oracleDivergenceBps: 200
maxRpcCallsPerSec: 5
paths:
  state: /tmp/bert-xemm-bot-state.db
  heartbeat: /tmp/bert-xemm-bot-heartbeat
  keyfile: /tmp/keyfile.json
notifier:
  discordWebhookUrl: https://example.com/hook
`;

function validConfig(): BotConfig {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
  const p = join(dir, 'cfg.yaml');
  writeFileSync(p, VALID_YAML);
  return loadConfig(p);
}

describe('config', () => {
  it('parses a minimal valid config', () => {
    const cfg = validConfig();
    expect(cfg.mode).toBe('observer');
    expect(cfg.quoter.cadenceMs).toBe(2500);
    expect(cfg.watchdog.conditions.netDeltaUsd).toBe(500);
  });

  it('rejects invalid mode (with otherwise-valid config)', () => {
    const base = validConfig();
    expect(() => BotConfigSchema.parse({ ...base, mode: 'bogus' })).toThrow();
  });

  it('rejects negative bufferBps (with otherwise-valid config)', () => {
    const base = validConfig();
    expect(() => BotConfigSchema.parse({ ...base, quoter: { ...base.quoter, bufferBps: -10 } })).toThrow();
  });
});
