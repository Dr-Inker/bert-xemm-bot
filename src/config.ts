import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

export const BotConfigSchema = z.object({
  mode: z.enum(['observer', 'live']),
  enabled: z.boolean(),

  kraken: z.object({
    pair: z.string().min(1),
    cliBinaryPath: z.string().min(1),
    apiKeyEnv: z.string().min(1),
    apiSecretEnv: z.string().min(1),
    feeTierRefreshSec: z.number().int().positive(),
  }),

  raydium: z.object({
    poolAddress: z.string().length(44).or(z.string().length(43)),
    rpcUrl: z.string().url(),
    jitoBlockEngine: z.string().min(1),
  }),

  jupiter: z.object({
    baseUrl: z.string().url(),
    maxSlippageBps: z.number().int().positive().max(1000),
  }),

  observer: z.object({
    sizesBert: z.array(z.number().positive()).min(1).max(10).default([1000, 5000, 10000]),
    maxBookAgeSec: z.number().int().positive().default(15),
    sampleCadenceMs: z.number().int().min(5000).max(300_000).default(30_000),
  }).default({ sizesBert: [1000, 5000, 10000], maxBookAgeSec: 15, sampleCadenceMs: 30_000 }),

  paper: z.object({
    enabled: z.boolean().default(true),
    minNetEdgeBps: z.number().nonnegative().default(40),
    latencyPenaltyBps: z.number().nonnegative().default(20),
    failedHedgeReserveBps: z.number().nonnegative().default(10),
    transactionCostUsd: z.number().nonnegative().default(0.02),
  }).default({ enabled: true, minNetEdgeBps: 40, latencyPenaltyBps: 20, failedHedgeReserveBps: 10, transactionCostUsd: 0.02 }),

  quoter: z.object({
    cadenceMs: z.number().int().min(500).max(60_000),
    bufferBps: z.number().nonnegative(),
    driftThresholdBps: z.number().nonnegative(),
    inventorySkewBpsPerUsd: z.number().nonnegative(),
    minEdgeBps: z.number().nonnegative(),
  }),

  inventory: z.object({
    maxNetUsd: z.number().positive(),
  }),

  watchdog: z.object({
    cadenceMs: z.number().int().min(1000).max(60_000),
    conditions: z.object({
      netDeltaUsd: z.number().positive(),
      dailyPnlPct: z.number().negative(),
      raydium24hMinUsd: z.number().positive(),
      kraken24hMinUsd: z.number().positive(),
      solUsd1hMaxAbsPct: z.number().positive(),
      rpcCallsPerMinHalt: z.number().int().positive(),
      adverseFillRateMax: z.number().min(0).max(1),
      staleDataSeconds: z.number().int().positive(),
    }),
  }),

  oracleDivergenceBps: z.number().int().positive(),
  maxRpcCallsPerSec: z.number().positive(),

  paths: z.object({
    state: z.string().min(1),
    heartbeat: z.string().min(1),
    keyfile: z.string().min(1),
  }),

  notifier: z.object({
    telegram: z.object({
      botTokenEnv: z.string().min(1),
      chatId: z.string().min(1),
    }).optional(),
    discordWebhookUrl: z.string().url().optional(),
  }),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

export function loadConfig(path: string): BotConfig {
  const raw = readFileSync(path, 'utf8');
  const parsed = parseYaml(raw);
  return BotConfigSchema.parse(parsed);
}
