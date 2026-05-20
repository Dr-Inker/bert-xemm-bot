import { describe, it, expect } from 'vitest';
import { execFileNoThrow } from '../../src/utils/execFileNoThrow.js';

describe('execFileNoThrow', () => {
  it('returns stdout for a successful command', async () => {
    const r = await execFileNoThrow('/bin/echo', ['hello world']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('hello world');
  });

  it('returns non-zero status and stderr on failure', async () => {
    const r = await execFileNoThrow('/bin/sh', ['-c', 'exit 7']);
    expect(r.status).toBe(7);
  });

  it('refuses argv strings that contain shell metacharacters when strictArgs is true', async () => {
    await expect(execFileNoThrow('/bin/echo', ['ok; rm -rf /'], { strictArgs: true }))
      .rejects.toThrow(/refused/i);
  });
});
