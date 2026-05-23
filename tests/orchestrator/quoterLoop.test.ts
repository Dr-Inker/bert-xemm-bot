import { describe, it, expect, vi } from 'vitest';
import Decimal from 'decimal.js';
import { QuoterLoop } from '../../src/orchestrator/quoterLoop.js';

describe('QuoterLoop.tick', () => {
  it('persists basis_sample on every tick and dispatches place intents to venue', async () => {
    const venue = {
      placeLimit: vi.fn().mockResolvedValue('OABC'),
      amend: vi.fn(),
      cancel: vi.fn(),
    };
    const store = {
      insertBasisSample: vi.fn(),
      getFlag: vi.fn().mockReturnValue(null),
      insertOrder: vi.fn(),
    };
    const inputs = {
      ref: { raydiumMidUsd: new Decimal('0.0177'), solUsd: new Decimal('86.12'), asOf: new Date() },
      oracleTrusted: true,
      krakenBook: { pair: 'BERTUSD', bids: [{ price: new Decimal('0.0175'), volume: new Decimal('5000') }], asks: [{ price: new Decimal('0.0179'), volume: new Decimal('3000') }], t: new Date() },
      openOrders: [],
      inventory: { bertNet: new Decimal('0'), usdNet: new Decimal('0'), asOf: new Date() },
      feeTier: { makerBps: 16, takerBps: 26 },
      dexCostBps: 35,
      // Net edge = 130 - (16 + 35) = 79 >= minEdgeBps(20) → place.
      config: { bufferBps: 130, driftThresholdBps: 15, inventorySkewBpsPerUsd: 0.05, minEdgeBps: 20, maxInventoryUsd: 500, defaultVolumeBert: new Decimal('1000') },
    };
    const loop = new QuoterLoop({
      cex: venue as never, store: store as never,
      readInputs: async () => inputs,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });
    await loop.tick();
    expect(store.insertBasisSample).toHaveBeenCalledTimes(1);
    expect(venue.placeLimit).toHaveBeenCalledTimes(2);
    expect(store.insertOrder).toHaveBeenCalledTimes(2);
  });

  it('does not record basis sample when both book sides are empty', async () => {
    const venue = { placeLimit: vi.fn(), amend: vi.fn(), cancel: vi.fn() };
    const store = { insertBasisSample: vi.fn(), getFlag: vi.fn().mockReturnValue(null), insertOrder: vi.fn() };
    const inputs = {
      ref: { raydiumMidUsd: new Decimal('0.0177'), solUsd: new Decimal('86.12'), asOf: new Date() },
      oracleTrusted: true,
      krakenBook: { pair: 'BERTUSD', bids: [], asks: [], t: new Date() },
      openOrders: [],
      inventory: { bertNet: new Decimal('0'), usdNet: new Decimal('0'), asOf: new Date() },
      feeTier: { makerBps: 16, takerBps: 26 },
      dexCostBps: 35,
      config: { bufferBps: 130, driftThresholdBps: 15, inventorySkewBpsPerUsd: 0.05, minEdgeBps: 20, maxInventoryUsd: 500, defaultVolumeBert: new Decimal('1000') },
    };
    const loop = new QuoterLoop({
      cex: venue as never, store: store as never,
      readInputs: async () => inputs,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });
    await loop.tick();
    expect(store.insertBasisSample).not.toHaveBeenCalled();
  });

  it('does not record basis sample when only one side is populated', async () => {
    const venue = { placeLimit: vi.fn(), amend: vi.fn(), cancel: vi.fn() };
    const store = { insertBasisSample: vi.fn(), getFlag: vi.fn().mockReturnValue(null), insertOrder: vi.fn() };
    const inputs = {
      ref: { raydiumMidUsd: new Decimal('0.0177'), solUsd: new Decimal('86.12'), asOf: new Date() },
      oracleTrusted: true,
      krakenBook: { pair: 'BERTUSD', bids: [{ price: new Decimal('0.0175'), volume: new Decimal('5000') }], asks: [], t: new Date() },
      openOrders: [],
      inventory: { bertNet: new Decimal('0'), usdNet: new Decimal('0'), asOf: new Date() },
      feeTier: { makerBps: 16, takerBps: 26 },
      dexCostBps: 35,
      config: { bufferBps: 130, driftThresholdBps: 15, inventorySkewBpsPerUsd: 0.05, minEdgeBps: 20, maxInventoryUsd: 500, defaultVolumeBert: new Decimal('1000') },
    };
    const loop = new QuoterLoop({
      cex: venue as never, store: store as never,
      readInputs: async () => inputs,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });
    await loop.tick();
    expect(store.insertBasisSample).not.toHaveBeenCalled();
  });

  it('records basis sample when both book sides are populated', async () => {
    const venue = {
      placeLimit: vi.fn().mockResolvedValue('OABC'),
      amend: vi.fn(),
      cancel: vi.fn(),
    };
    const store = { insertBasisSample: vi.fn(), getFlag: vi.fn().mockReturnValue(null), insertOrder: vi.fn() };
    const inputs = {
      ref: { raydiumMidUsd: new Decimal('0.0177'), solUsd: new Decimal('86.12'), asOf: new Date() },
      oracleTrusted: true,
      krakenBook: { pair: 'BERTUSD', bids: [{ price: new Decimal('0.0175'), volume: new Decimal('5000') }], asks: [{ price: new Decimal('0.0179'), volume: new Decimal('3000') }], t: new Date() },
      openOrders: [],
      inventory: { bertNet: new Decimal('0'), usdNet: new Decimal('0'), asOf: new Date() },
      feeTier: { makerBps: 16, takerBps: 26 },
      dexCostBps: 35,
      config: { bufferBps: 130, driftThresholdBps: 15, inventorySkewBpsPerUsd: 0.05, minEdgeBps: 20, maxInventoryUsd: 500, defaultVolumeBert: new Decimal('1000') },
    };
    const loop = new QuoterLoop({
      cex: venue as never, store: store as never,
      readInputs: async () => inputs,
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });
    await loop.tick();
    expect(store.insertBasisSample).toHaveBeenCalledTimes(1);
  });

  it('emits no place intents when `degraded` flag is set', async () => {
    const venue = { placeLimit: vi.fn(), amend: vi.fn(), cancel: vi.fn() };
    const store = { insertBasisSample: vi.fn(), getFlag: vi.fn().mockReturnValue('1'), insertOrder: vi.fn() };
    const loop = new QuoterLoop({
      cex: venue as never, store: store as never,
      readInputs: async () => { throw new Error('readInputs should not run when degraded'); },
      logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never,
    });
    await loop.tick();
    expect(venue.placeLimit).not.toHaveBeenCalled();
  });
});
