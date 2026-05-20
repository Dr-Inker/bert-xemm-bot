import { describe, it, expect } from 'vitest';
import { newClOrdId } from '../src/types.js';

describe('newClOrdId', () => {
  it('generates unique, prefix-tagged ids', () => {
    const a = newClOrdId('test');
    const b = newClOrdId('test');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^test-/);
  });
});
