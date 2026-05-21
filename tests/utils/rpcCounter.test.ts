import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RpcCounter } from '../../src/utils/rpcCounter.js';

describe('RpcCounter', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-05-21T00:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns 0 when never called', () => {
    expect(new RpcCounter().callsPerMin()).toBe(0);
  });

  it('counts recent calls within the 60s window', () => {
    const c = new RpcCounter();
    c.incr(); c.incr(); c.incr();
    expect(c.callsPerMin()).toBe(3);
  });

  it('drops calls older than 60s', () => {
    const c = new RpcCounter();
    c.incr(); c.incr();                   // t=0
    vi.advanceTimersByTime(30_000);
    c.incr();                             // t=30s
    vi.advanceTimersByTime(31_000);       // now t=61s; first two are >60s old
    expect(c.callsPerMin()).toBe(1);
  });
});
