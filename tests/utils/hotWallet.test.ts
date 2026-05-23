import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Keypair } from '@solana/web3.js';
import { loadHotWallet } from '../../src/utils/hotWallet.js';

describe('loadHotWallet', () => {
  it('loads a keypair from a JSON byte-array keyfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xemm-wallet-'));
    try {
      const kp = Keypair.generate();
      const path = join(dir, 'hot-wallet.json');
      writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
      const loaded = loadHotWallet(path);
      expect(loaded.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on invalid keyfile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xemm-wallet-'));
    try {
      const path = join(dir, 'bad.json');
      writeFileSync(path, JSON.stringify([]));
      expect(() => loadHotWallet(path)).toThrow(/invalid hot wallet keyfile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
