import { describe, expect, it, vi } from 'vitest';
import { CandidateConfigSchema } from '../src/config.js';
import {
  CandidateCallAdmission,
  CandidateLaneGuard,
  candidateStrategyFingerprint,
  resolveCandidateApiKey,
} from '../src/candidateRuntime.js';

describe('candidate keyed runtime controls', () => {
  it('refuses an enabled lane when its configured API key is absent or empty', () => {
    const config = CandidateConfigSchema.parse({ enabled: true, apiKeyEnv: 'CANDIDATE_KEY' });
    expect(resolveCandidateApiKey(config, {})).toEqual({
      canStart: false, apiKey: null, reason: 'missing_api_key',
    });
    expect(resolveCandidateApiKey(config, { CANDIDATE_KEY: '   ' })).toEqual({
      canStart: false, apiKey: null, reason: 'missing_api_key',
    });
    expect(resolveCandidateApiKey(config, { CANDIDATE_KEY: 'secret-value' })).toEqual({
      canStart: true, apiKey: 'secret-value', reason: null,
    });
  });

  it('admits a complete snapshot atomically or skips it without a backlog', () => {
    let now = 0;
    const admission = new CandidateCallAdmission(6, () => now);
    expect(admission.tryAdmit(4)).toBe(true);
    expect(admission.tryAdmit(4)).toBe(false);
    now = 999;
    expect(admission.tryAdmit(4)).toBe(false);
    now = 1000;
    expect(admission.tryAdmit(4)).toBe(true);
    // The rejected calls were never queued or charged later.
    expect(admission.tryAdmit(2)).toBe(true);
  });

  it('opens a provider gate, respects reset, and latches after three consecutive 429s', () => {
    const changes = vi.fn();
    const guard = new CandidateLaneGuard({
      disableOnProviderRateLimit: true,
      providerRateLimitConsecutiveThreshold: 3,
      providerRateLimitDefaultCooldownMs: 60_000,
      baselineWatchdogMs: 45_000,
      activatedAtMs: 0,
      onStateChange: changes,
    });

    guard.recordProviderRateLimit(10_000, 1000);
    expect(guard.activeGates()).toEqual([expect.objectContaining({ gate: 'provider_rate_limited' })]);
    expect(guard.canAttemptProvider(9999)).toBe(false);
    expect(guard.canAttemptProvider(10_000)).toBe(true);
    expect(guard.isLatched()).toBe(false);

    guard.recordProviderRateLimit(null, 10_000);
    expect(guard.canAttemptProvider(69_999)).toBe(false);
    guard.recordProviderRateLimit(null, 70_000);
    expect(guard.isLatched()).toBe(true);
    expect(guard.latchedReason()).toBe('provider_rate_limited');
    expect(guard.canAttemptProvider(Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(guard.activeGates()[0]?.detailJson).toContain('"latched":true');
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('latches when the baseline has not succeeded inside its watchdog window', () => {
    const guard = new CandidateLaneGuard({
      disableOnProviderRateLimit: true,
      providerRateLimitConsecutiveThreshold: 3,
      providerRateLimitDefaultCooldownMs: 60_000,
      baselineWatchdogMs: 45_000,
      activatedAtMs: 1000,
    });
    guard.recordBaselineSuccess(10_000);
    expect(guard.checkBaselineWatchdog(54_999)).toBe(false);
    expect(guard.checkBaselineWatchdog(55_000)).toBe(true);
    expect(guard.latchedReason()).toBe('baseline_watchdog');
    expect(guard.activeGates()).toEqual([expect.objectContaining({ gate: 'baseline_watchdog' })]);
  });

  it('produces a stable fingerprint and changes it when the operating point changes', () => {
    const config = CandidateConfigSchema.parse({});
    const context = { jupiterMaxSlippageBps: 50 };
    const first = candidateStrategyFingerprint(config, context);
    const reordered = CandidateConfigSchema.parse({
      stressFriction: config.stressFriction,
      ladder: config.ladder.map(rung => ({ ...rung })),
      maxQuoteCallsPerSec: config.maxQuoteCallsPerSec,
    });
    expect(candidateStrategyFingerprint(reordered, context)).toBe(first);
    expect(candidateStrategyFingerprint({ ...config, maxQuoteCallsPerSec: 7 }, context)).not.toBe(first);
    expect(candidateStrategyFingerprint({
      ...config,
      ladder: config.ladder.map((rung, index) => index === 0 ? { ...rung, distanceBps: 176 } : rung),
    }, context)).not.toBe(first);
    expect(candidateStrategyFingerprint(config, { jupiterMaxSlippageBps: 75 })).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
