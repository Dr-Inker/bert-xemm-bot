import { KrakenClient, type KrakenClientConfig } from './krakenClient.js';
import type { FeeTier } from '../types.js';

export class KrakenPaper extends KrakenClient {
  constructor(cfg: Omit<KrakenClientConfig, 'paper'|'apiKeyEnv'|'apiSecretEnv'>) {
    super({ ...cfg, paper: true, apiKeyEnv: 'UNUSED', apiSecretEnv: 'UNUSED' });
  }
  override async feeTier(): Promise<FeeTier> {
    return { makerBps: 0, takerBps: 26 };
  }
}
