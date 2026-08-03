import { describe, it, expect, vi } from 'vitest';
import { KillSwitchWatchdog, failClosedEvaluate } from '../../src/risk/killSwitchWatchdog.js';
import type { KillResult } from '../../src/risk/conditions.js';

function harness(evaluate: () => Promise<KillResult[]>) {
  const store = { setFlag: vi.fn(), insertKillEvent: vi.fn() };
  const cex = { cancelAll: vi.fn().mockResolvedValue({ cancelled: 3 }) };
  const notifier = { page: vi.fn(), warn: vi.fn() };
  const watchdog = new KillSwitchWatchdog({ store, cex, notifier, evaluate });
  return { store, cex, notifier, watchdog };
}

describe('failClosedEvaluate', () => {
  it('returns accumulated results when the body succeeds', async () => {
    const evaluate = failClosedEvaluate(async (out) => {
      out.push({ tripped: false, action: 'cancel_all_reduce_only' });
    }, vi.fn());
    const results = await evaluate();
    expect(results).toHaveLength(1);
    expect(results[0]?.tripped).toBe(false);
  });

  it('appends a tripped watchdog_evaluate_error result when the body throws', async () => {
    const onError = vi.fn();
    const evaluate = failClosedEvaluate(async (out) => {
      out.push({ tripped: false, action: 'cancel_all_reduce_only' });
      throw new Error('poolMidUsd exploded');
    }, onError);
    const results = await evaluate();
    expect(onError).toHaveBeenCalled();
    const err = results.find(r => r.reason === 'watchdog_evaluate_error');
    expect(err).toBeDefined();
    expect(err?.tripped).toBe(true);
    expect(err?.action).toBe('cancel_all_refuse_resume');
  });

  it('fails closed even when the body throws before pushing anything', async () => {
    const evaluate = failClosedEvaluate(async () => { throw new Error('boom'); }, vi.fn());
    const results = await evaluate();
    expect(results).toEqual([
      { tripped: true, reason: 'watchdog_evaluate_error', action: 'cancel_all_refuse_resume' },
    ]);
  });
});

describe('KillSwitchWatchdog fail-closed integration', () => {
  it('an evaluate body that throws trips the watchdog (cancelAll + degraded + page)', async () => {
    const { store, cex, notifier, watchdog } = harness(
      failClosedEvaluate(async () => { throw new Error('kraken 24h fetch failed'); }, vi.fn()),
    );
    const tripped = await watchdog.tick();
    expect(tripped).toHaveLength(1);
    expect(tripped[0]?.reason).toBe('watchdog_evaluate_error');
    expect(cex.cancelAll).toHaveBeenCalledTimes(1);
    expect(store.setFlag).toHaveBeenCalledWith('degraded', '1');
    expect(store.insertKillEvent).toHaveBeenCalledWith(expect.objectContaining({
      actionTaken: 'cancel_all_refuse_resume',
    }));
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('watchdog_evaluate_error'));
  });

  it('cancelAll rejecting still latches degraded, persists the kill event and pages', async () => {
    const { store, cex, notifier, watchdog } = harness(
      failClosedEvaluate(async () => { throw new Error('evaluate exploded'); }, vi.fn()),
    );
    cex.cancelAll.mockRejectedValue(new Error('kraken cancelAll 500'));
    const tripped = await watchdog.tick();
    expect(tripped).toHaveLength(1);
    expect(store.setFlag).toHaveBeenCalledWith('degraded', '1');
    expect(store.insertKillEvent).toHaveBeenCalledWith(expect.objectContaining({
      actionTaken: 'cancel_all_refuse_resume',
    }));
    expect(notifier.page).toHaveBeenCalledWith(expect.stringContaining('watchdog_evaluate_error'));
    expect(cex.cancelAll).toHaveBeenCalledTimes(1);
  });

  it('latches degraded and persists the kill event before cancelAll is attempted', async () => {
    const order: string[] = [];
    const { store, cex, watchdog } = harness(
      failClosedEvaluate(async () => { throw new Error('boom'); }, vi.fn()),
    );
    store.setFlag.mockImplementation(() => { order.push('degraded'); });
    store.insertKillEvent.mockImplementation(() => { order.push('event'); });
    cex.cancelAll.mockImplementation(() => { order.push('cancel'); return Promise.resolve({ cancelled: 0 }); });
    await watchdog.tick();
    expect(order).toEqual(['degraded', 'event', 'cancel']);
  });

  it('a failing store does not prevent the page or the cancelAll', async () => {
    const { store, cex, notifier, watchdog } = harness(
      failClosedEvaluate(async () => { throw new Error('boom'); }, vi.fn()),
    );
    store.setFlag.mockImplementation(() => { throw new Error('sqlite disk I/O error'); });
    store.insertKillEvent.mockImplementation(() => { throw new Error('sqlite disk I/O error'); });
    const tripped = await watchdog.tick();
    expect(tripped).toHaveLength(1);
    expect(notifier.page).toHaveBeenCalled();
    expect(cex.cancelAll).toHaveBeenCalledTimes(1);
  });

  it('a throwing notifier does not prevent the cancelAll', async () => {
    const { cex, notifier, watchdog } = harness(
      failClosedEvaluate(async () => { throw new Error('boom'); }, vi.fn()),
    );
    notifier.page.mockImplementation(() => { throw new Error('discord webhook down'); });
    await expect(watchdog.tick()).resolves.toHaveLength(1);
    expect(cex.cancelAll).toHaveBeenCalledTimes(1);
  });

  it('a clean evaluate body does not trip the watchdog', async () => {
    const { cex, store, watchdog } = harness(
      failClosedEvaluate(async (out) => {
        out.push({ tripped: false, action: 'halt_24h' });
      }, vi.fn()),
    );
    const tripped = await watchdog.tick();
    expect(tripped).toEqual([]);
    expect(cex.cancelAll).not.toHaveBeenCalled();
    expect(store.setFlag).not.toHaveBeenCalled();
  });
});
