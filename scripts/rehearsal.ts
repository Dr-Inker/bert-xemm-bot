import { loadConfig } from '../src/config.js';
import { logger } from '../src/logger.js';
import { decideQuotes } from '../src/strategy/xemmQuoter.js';
import Decimal from 'decimal.js';

const cfg = loadConfig(process.env.CONFIG_PATH ?? './config.example.yaml');
const start = Date.now();
const DURATION_MS = 60_000;

logger.info({ duration: DURATION_MS }, 'rehearsal: starting (no submission)');

async function tick(): Promise<void> {
  const intents = decideQuotes({
    ref: { raydiumMidUsd: new Decimal('0.0177'), solUsd: new Decimal('86.12'), asOf: new Date() },
    oracleTrusted: true,
    krakenBook: { pair: cfg.kraken.pair, bids: [], asks: [], t: new Date() },
    openOrders: [],
    inventory: { bertNet: new Decimal('0'), usdNet: new Decimal('0'), asOf: new Date() },
    feeTier: { makerBps: 16, takerBps: 26 },
    dexCostBps: 35,
    config: {
      bufferBps: cfg.quoter.bufferBps,
      driftThresholdBps: cfg.quoter.driftThresholdBps,
      inventorySkewBpsPerUsd: cfg.quoter.inventorySkewBpsPerUsd,
      minEdgeBps: cfg.quoter.minEdgeBps,
      maxInventoryUsd: cfg.inventory.maxNetUsd,
      defaultVolumeBert: new Decimal('1000'),
    },
  });
  logger.info({ intents: intents.length }, 'rehearsal tick');
}

while (Date.now() - start < DURATION_MS) {
  await tick();
  await new Promise(r => setTimeout(r, cfg.quoter.cadenceMs));
}
logger.info('rehearsal: done');
