import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

/** Load a Solana hot-wallet keypair from a JSON byte-array keyfile (bert-mm-bot convention). */
export function loadHotWallet(keyfilePath: string): Keypair {
  const keyJson = JSON.parse(readFileSync(keyfilePath, 'utf8')) as number[];
  if (!Array.isArray(keyJson) || keyJson.length === 0) {
    throw new Error(`invalid hot wallet keyfile: ${keyfilePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(keyJson));
}
