import { describe, it, expect, vi } from 'vitest';
import { createDegradedGate } from '../../src/risk/degradedGate.js';

describe('createDegradedGate', () => {
  it('reports degraded from the durable store when it is readable', () => {
    const store = { getFlag: vi.fn().mockReturnValue('1'), setFlag: vi.fn() };
    const gate = createDegradedGate(store);
    expect(gate.getFlag('degraded')).toBe('1');
  });

  it('keeps the quoter gate closed when the durable setFlag fails', () => {
    // The disk write is the fallible part; losing it must not re-open quoting.
    const store = {
      getFlag: vi.fn().mockReturnValue(null),
      setFlag: vi.fn(() => { throw new Error('sqlite disk I/O error'); }),
    };
    const gate = createDegradedGate(store);
    gate.latchDegraded();
    expect(() => gate.setFlag('degraded', '1')).toThrow();
    expect(gate.getFlag('degraded')).toBe('1');
  });

  it('latches in memory even if the store read later succeeds and says otherwise', () => {
    const store = { getFlag: vi.fn().mockReturnValue('0'), setFlag: vi.fn() };
    const gate = createDegradedGate(store);
    expect(gate.getFlag('degraded')).toBe('0');
    gate.latchDegraded();
    expect(gate.getFlag('degraded')).toBe('1');
  });

  it('passes other flags straight through', () => {
    const store = { getFlag: vi.fn().mockReturnValue('xyz'), setFlag: vi.fn() };
    const gate = createDegradedGate(store);
    gate.latchDegraded();
    expect(gate.getFlag('emergency_unwind_complete')).toBe('xyz');
    gate.setFlag('emergency_unwind_complete', '1');
    expect(store.setFlag).toHaveBeenCalledWith('emergency_unwind_complete', '1');
  });

  it('a durable degraded write also arms the in-memory latch', () => {
    const store = { getFlag: vi.fn().mockReturnValue(null), setFlag: vi.fn() };
    const gate = createDegradedGate(store);
    gate.setFlag('degraded', '1');
    store.getFlag.mockReturnValue(null);
    expect(gate.getFlag('degraded')).toBe('1');
  });
});
