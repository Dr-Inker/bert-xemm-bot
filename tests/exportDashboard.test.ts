import { describe, expect, it } from 'vitest';
import { sanitizeCandidateDashboardIdentity } from '../src/candidateRuntime.js';

describe('candidate dashboard export', () => {
  it('exports the current fingerprint through an allow-list that drops key material', () => {
    const identity = sanitizeCandidateDashboardIdentity({
      economicFingerprint: 'economic-dashboard-test',
      operationalFingerprint: 'operational-dashboard-test',
      activatedAt: '2026-08-03T00:00:00.000Z',
      latchedAt: null,
      latchReason: null,
      apiKey: 'must-never-appear',
      apiKeyEnv: 'JUPITER_API_KEY',
    });
    const output = JSON.stringify(identity);

    expect(identity.economicFingerprint).toBe('economic-dashboard-test');
    expect(identity.operationalFingerprint).toBe('operational-dashboard-test');
    expect(output).not.toContain('must-never-appear');
    expect(output).not.toContain('JUPITER_API_KEY');
    expect(Object.keys(identity).sort()).toEqual([
      'activatedAt', 'economicFingerprint', 'latchReason', 'latchedAt', 'operationalFingerprint',
    ]);
  });
});
