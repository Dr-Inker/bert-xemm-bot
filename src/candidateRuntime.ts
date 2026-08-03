import { createHash } from 'node:crypto';
import type { CandidateConfig } from './config.js';

export const CANDIDATE_STRATEGY_IMPLEMENTATION = 'candidate-shadow-v2-keyed-1';

export interface CandidateGateRecord {
  gate: 'provider_rate_limited' | 'baseline_watchdog';
  detailJson: string;
}

/**
 * A rolling one-second call budget. Reservations are atomic and never wait, so
 * a rejected snapshot cannot become a queued catch-up burst later.
 */
export class CandidateCallAdmission {
  private reservations: Array<{ atMs: number; count: number }> = [];

  constructor(
    private readonly maxCallsPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(maxCallsPerSec) || maxCallsPerSec <= 0) {
      throw new Error('maxCallsPerSec must be a positive integer');
    }
  }

  tryAdmit(callCount: number, atMs = this.now()): boolean {
    if (!Number.isInteger(callCount) || callCount <= 0) throw new Error('callCount must be a positive integer');
    const cutoff = atMs - 1000;
    this.reservations = this.reservations.filter(reservation => reservation.atMs > cutoff);
    const used = this.reservations.reduce((total, reservation) => total + reservation.count, 0);
    if (used + callCount > this.maxCallsPerSec) return false;
    this.reservations.push({ atMs, count: callCount });
    return true;
  }
}

export interface CandidateStartupDecision {
  canStart: boolean;
  apiKey: string | null;
  reason: 'disabled' | 'missing_api_key' | null;
}

export interface CandidateDashboardIdentityInput {
  strategyFingerprint: string | null;
  activatedAt: string | null;
  latchedAt: string | null;
  latchReason: string | null;
  apiKey?: string;
  apiKeyEnv?: string;
}

/** Allow-list the only runtime identity fields permitted in dashboard output. */
export function sanitizeCandidateDashboardIdentity(input: CandidateDashboardIdentityInput): {
  strategyFingerprint: string | null;
  activatedAt: string | null;
  latchedAt: string | null;
  latchReason: string | null;
} {
  return {
    strategyFingerprint: input.strategyFingerprint,
    activatedAt: input.activatedAt,
    latchedAt: input.latchedAt,
    latchReason: input.latchReason,
  };
}

/** Resolve the configured environment variable without ever copying it into config. */
export function resolveCandidateApiKey(
  config: Pick<CandidateConfig, 'enabled' | 'apiKeyEnv'>,
  env: NodeJS.ProcessEnv = process.env,
): CandidateStartupDecision {
  if (!config.enabled) return { canStart: false, apiKey: null, reason: 'disabled' };
  const value = env[config.apiKeyEnv]?.trim();
  if (!value) return { canStart: false, apiKey: null, reason: 'missing_api_key' };
  return { canStart: true, apiKey: value, reason: null };
}

/** Stable, secret-free identity for evidence generated under one operating point. */
export function candidateStrategyFingerprint(
  config: CandidateConfig,
  context: { jupiterMaxSlippageBps: number },
): string {
  const material = {
    implementation: CANDIDATE_STRATEGY_IMPLEMENTATION,
    snapshotQuoteDirectionsPerSize: 2,
    postOnlyTickUsd: '0.000001',
    jupiterMaxSlippageBps: context.jupiterMaxSlippageBps,
    config: {
      jupiterBaseUrl: config.jupiterBaseUrl,
      maxQuoteCallsPerSec: config.maxQuoteCallsPerSec,
      disableOnProviderRateLimit: config.disableOnProviderRateLimit,
      providerRateLimitConsecutiveThreshold: config.providerRateLimitConsecutiveThreshold,
      providerRateLimitDefaultCooldownMs: config.providerRateLimitDefaultCooldownMs,
      baselineWatchdogMs: config.baselineWatchdogMs,
      ladder: config.ladder,
      minAllInEdgeBps: config.minAllInEdgeBps,
      decisionCadenceMs: config.decisionCadenceMs,
      repriceThresholdBps: config.repriceThresholdBps,
      maxQuoteAgeMs: config.maxQuoteAgeMs,
      crossVenueMaxBps: config.crossVenueMaxBps,
      routeVsReserveMaxBps: config.routeVsReserveMaxBps,
      maxBookAgeSec: config.maxBookAgeSec,
      drift5sBps: config.drift5sBps,
      drift30sBps: config.drift30sBps,
      driftResumeStableSec: config.driftResumeStableSec,
      maxPendingHedgeAgeMs: config.maxPendingHedgeAgeMs,
      maxActivePerSideBert: config.maxActivePerSideBert,
      normalFriction: config.normalFriction,
      stressFriction: config.stressFriction,
    },
  };
  return createHash('sha256').update(stableJson(material)).digest('hex');
}

export interface CandidateLaneGuardOptions {
  disableOnProviderRateLimit: boolean;
  providerRateLimitConsecutiveThreshold: number;
  providerRateLimitDefaultCooldownMs: number;
  baselineWatchdogMs: number;
  activatedAtMs?: number;
  onStateChange?: () => void;
}

/** Provider cooldown, process-lifetime latches, and baseline starvation guard. */
export class CandidateLaneGuard {
  private readonly activatedAtMs: number;
  private lastBaselineSuccessAtMs: number | null = null;
  private consecutive429s = 0;
  private provider429s = 0;
  private nextProviderAttemptAtMs = 0;
  private providerGateDetail: string | null = null;
  private latchReason: 'provider_rate_limited' | 'baseline_watchdog' | null = null;
  private onStateChange: (() => void) | undefined;

  constructor(private readonly opts: CandidateLaneGuardOptions) {
    this.activatedAtMs = opts.activatedAtMs ?? Date.now();
    this.onStateChange = opts.onStateChange;
  }

  setOnStateChange(listener: () => void): void { this.onStateChange = listener; }

  isLatched(): boolean { return this.latchReason !== null; }
  latchedReason(): string | null { return this.latchReason; }
  total429Count(): number { return this.provider429s; }
  consecutive429Count(): number { return this.consecutive429s; }
  canAttemptProvider(nowMs = Date.now()): boolean {
    return !this.isLatched() && nowMs >= this.nextProviderAttemptAtMs;
  }

  recordBaselineSuccess(atMs = Date.now()): void {
    this.lastBaselineSuccessAtMs = atMs;
  }

  baselineSampleAgeMs(nowMs = Date.now()): number {
    return Math.max(0, nowMs - (this.lastBaselineSuccessAtMs ?? this.activatedAtMs));
  }

  checkBaselineWatchdog(nowMs = Date.now()): boolean {
    if (this.isLatched() || this.baselineSampleAgeMs(nowMs) < this.opts.baselineWatchdogMs) return false;
    this.latchReason = 'baseline_watchdog';
    this.emit();
    return true;
  }

  recordProviderRateLimit(rateLimitResetAtMs: number | null, nowMs = Date.now()): void {
    this.provider429s += 1;
    this.consecutive429s += 1;
    this.nextProviderAttemptAtMs = rateLimitResetAtMs === null
      ? nowMs + this.opts.providerRateLimitDefaultCooldownMs
      : Math.max(nowMs + 1000, rateLimitResetAtMs);
    const shouldLatch = this.opts.disableOnProviderRateLimit
      && this.consecutive429s >= this.opts.providerRateLimitConsecutiveThreshold;
    if (shouldLatch) this.latchReason = 'provider_rate_limited';
    this.providerGateDetail = JSON.stringify({
      consecutive429s: this.consecutive429s,
      total429s: this.provider429s,
      nextAttemptAt: new Date(this.nextProviderAttemptAtMs).toISOString(),
      latched: shouldLatch,
    });
    this.emit();
  }

  recordSnapshotSuccess(): void {
    if (this.isLatched()) return;
    this.consecutive429s = 0;
    this.nextProviderAttemptAtMs = 0;
    this.providerGateDetail = null;
    this.emit();
  }

  activeGates(): CandidateGateRecord[] {
    const gates: CandidateGateRecord[] = [];
    if (this.providerGateDetail !== null) {
      gates.push({ gate: 'provider_rate_limited', detailJson: this.providerGateDetail });
    }
    if (this.latchReason === 'baseline_watchdog') {
      gates.push({
        gate: 'baseline_watchdog',
        detailJson: JSON.stringify({
          maxAgeMs: this.opts.baselineWatchdogMs,
          latched: true,
        }),
      });
    }
    return gates;
  }

  private emit(): void { this.onStateChange?.(); }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
