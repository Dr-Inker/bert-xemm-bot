import { describe, it, expect, vi } from 'vitest';
import { runPause } from '../../src/cli/pause.js';
import { runResume } from '../../src/cli/resume.js';

describe('CLI pause/resume', () => {
  it('pause sets degraded=1', () => {
    const store = { setFlag: vi.fn() };
    runPause(store as never);
    expect(store.setFlag).toHaveBeenCalledWith('degraded', '1');
  });
  it('resume clears degraded and emergency_unwind_complete', () => {
    const store = { setFlag: vi.fn() };
    runResume(store as never);
    expect(store.setFlag).toHaveBeenCalledWith('degraded', '0');
    expect(store.setFlag).toHaveBeenCalledWith('emergency_unwind_complete', '0');
  });
});
