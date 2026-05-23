import { describe, it, expect } from 'vitest';
import { toWsPair } from '../../src/venues/krakenPair.js';

describe('toWsPair', () => {
  it('converts BERTUSD to BERT/USD', () => {
    expect(toWsPair('BERTUSD')).toBe('BERT/USD');
  });

  it('passes through slash pairs', () => {
    expect(toWsPair('BERT/USD')).toBe('BERT/USD');
  });
});
