import { describe, it, expect } from 'vitest';
import { execFileNoThrow } from '../../src/utils/execFileNoThrow.js';
import { existsSync } from 'node:fs';

const KRAKEN = process.env.KRAKEN_CLI_PATH ?? '/usr/local/bin/kraken';
const hasKraken = existsSync(KRAKEN);

describe('Kraken paper E2E (skipped if `kraken` not on PATH)', () => {
  it.skipIf(!hasKraken)('initializes paper account', async () => {
    const r = await execFileNoThrow(KRAKEN, ['paper', 'init', '--balance', '10000', '-o', 'json']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toHaveProperty('balance');
  });
});
