import { describe, it, expect } from 'vitest';
import {
  condSolUsd1hMove, condRpcBurn, condAdverseFill, condStaleData,
} from '../../src/risk/conditions.js';

describe('kill conditions 5-8', () => {
  it('solUsd1hMove trips when |%move| > threshold', () => {
    expect(condSolUsd1hMove({ pctMove1h: -6 }, { solUsd1hMaxAbsPct: 5 }).tripped).toBe(true);
    expect(condSolUsd1hMove({ pctMove1h: 4 },  { solUsd1hMaxAbsPct: 5 }).tripped).toBe(false);
  });

  it('rpcBurn trips when calls/min > halt threshold', () => {
    expect(condRpcBurn({ callsPerMin: 150 }, { rpcCallsPerMinHalt: 120 }).tripped).toBe(true);
  });

  it('adverseFill trips when adverse share of last N fills > threshold', () => {
    const r = condAdverseFill({ adverseShareLast20: 0.85 }, { adverseFillRateMax: 0.8 });
    expect(r.tripped).toBe(true);
    expect(r.action).toBe('withdraw_30min');
  });

  it('staleData trips when any source older than threshold seconds', () => {
    expect(condStaleData({ oldestSourceAgeSec: 31 }, { staleDataSeconds: 30 }).tripped).toBe(true);
    expect(condStaleData({ oldestSourceAgeSec: 5 },  { staleDataSeconds: 30 }).tripped).toBe(false);
  });
});
