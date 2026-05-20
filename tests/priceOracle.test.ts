import { describe, it, expect } from 'vitest';
import { trustedMid } from '../src/priceOracle.js';

describe('priceOracle.trustedMid', () => {
  it('returns median when ≥2 sources agree within divergence', () => {
    const out = trustedMid({
      samples: [
        { source: 'raydium',     midUsd: '0.01770' },
        { source: 'dexscreener', midUsd: '0.01773' },
        { source: 'jupiter',     midUsd: '0.01768' },
      ],
      maxDivergenceBps: 200,
    });
    expect(out.trusted).toBe(true);
    if (out.trusted) expect(out.medianUsd).toBe('0.0177');
  });

  it('refuses with <2 samples', () => {
    const out = trustedMid({
      samples: [{ source: 'raydium', midUsd: '0.01770' }],
      maxDivergenceBps: 200,
    });
    expect(out.trusted).toBe(false);
    if (!out.trusted) expect(out.reason).toMatch(/at least 2/i);
  });

  it('refuses when max-min divergence exceeds threshold', () => {
    const out = trustedMid({
      samples: [
        { source: 'raydium',     midUsd: '0.0177' },
        { source: 'dexscreener', midUsd: '0.0200' },
      ],
      maxDivergenceBps: 200,
    });
    expect(out.trusted).toBe(false);
    if (!out.trusted) expect(out.reason).toMatch(/divergence/i);
  });
});
