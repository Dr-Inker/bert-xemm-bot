import { describe, expect, it, vi } from 'vitest';
import { CandidateConfigSchema } from '../src/config.js';
import {
  CandidateCallAdmission,
  CandidateLaneGuard,
  candidateFingerprints,
  effectiveBaselineWatchdogMs,
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

  it('does not latch during a cold restart and slow first successful baseline size', () => {
    const graceMs = effectiveBaselineWatchdogMs(45_000, 30_000);
    expect(graceMs).toBe(90_000);
    const guard = new CandidateLaneGuard({
      disableOnProviderRateLimit: true,
      providerRateLimitConsecutiveThreshold: 3,
      providerRateLimitDefaultCooldownMs: 60_000,
      baselineWatchdogMs: graceMs,
    });

    // Candidate activation alone does not arm the watchdog. The cold-book tick does.
    expect(guard.checkBaselineWatchdog(1_000_000)).toBe(false);
    guard.recordBaselineAttempt(0);
    expect(guard.checkBaselineWatchdog(45_000)).toBe(false);
    guard.recordBaselineAttempt(30_000);
    expect(guard.checkBaselineWatchdog(59_999)).toBe(false);

    // The first completed size is enough; the remaining size loop may still be running.
    guard.recordBaselineSuccess(60_000);
    expect(guard.checkBaselineWatchdog(120_000)).toBe(false);
    expect(guard.isLatched()).toBe(false);
  });

  it('latches a genuinely dead baseline after the effective restart grace', () => {
    const graceMs = effectiveBaselineWatchdogMs(45_000, 30_000);
    const guard = new CandidateLaneGuard({
      disableOnProviderRateLimit: true,
      providerRateLimitConsecutiveThreshold: 3,
      providerRateLimitDefaultCooldownMs: 60_000,
      baselineWatchdogMs: graceMs,
    });
    guard.recordBaselineAttempt(1000);
    expect(guard.checkBaselineWatchdog(1000 + graceMs - 1)).toBe(false);
    expect(guard.checkBaselineWatchdog(1000 + graceMs)).toBe(true);
    expect(guard.latchedReason()).toBe('baseline_watchdog');
    expect(guard.activeGates()).toEqual([expect.objectContaining({ gate: 'baseline_watchdog' })]);
  });

  it('separates stable economic identity from operational tuning', () => {
    const config = CandidateConfigSchema.parse({});
    const context = { jupiterMaxSlippageBps: 50, observerSampleCadenceMs: 30_000 };
    const first = candidateFingerprints(config, context);
    const reordered = CandidateConfigSchema.parse({
      stressFriction: config.stressFriction,
      ladder: config.ladder.map(rung => ({ ...rung })),
      maxQuoteCallsPerSec: config.maxQuoteCallsPerSec,
    });
    expect(candidateFingerprints(reordered, context)).toEqual(first);

    const capacityChange = candidateFingerprints({ ...config, maxQuoteCallsPerSec: 7 }, context);
    expect(capacityChange.economicFingerprint).toBe(first.economicFingerprint);
    expect(capacityChange.operationalFingerprint).not.toBe(first.operationalFingerprint);

    const economicChange = candidateFingerprints({
      ...config,
      ladder: config.ladder.map((rung, index) => index === 0 ? { ...rung, distanceBps: 176 } : rung),
    }, context);
    expect(economicChange.economicFingerprint).not.toBe(first.economicFingerprint);
    expect(economicChange.operationalFingerprint).toBe(first.operationalFingerprint);

    const slippageChange = candidateFingerprints(config, { ...context, jupiterMaxSlippageBps: 75 });
    expect(slippageChange.economicFingerprint).not.toBe(first.economicFingerprint);
    expect(slippageChange.operationalFingerprint).toBe(first.operationalFingerprint);
    expect(first.economicFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first.operationalFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
