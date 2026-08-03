import { describe, it, expect, vi } from 'vitest';
import bs58 from 'bs58';
import { TxSubmitter } from '../src/txSubmitter.js';
import * as w3 from '@solana/web3.js';

// A realistic signed tx: 64-byte ed25519 signature in slot 0.
const SIG_BYTES = new Uint8Array(64).fill(7);
const EXPECTED_SIG = bs58.encode(SIG_BYTES);

function signedTx(wire: number[]) {
  return { serialize: () => new Uint8Array(wire), signatures: [SIG_BYTES] };
}

describe('TxSubmitter.submitProtected', () => {
  it('falls back to public RPC when Jito throws', async () => {
    const sig = 'PUBSIG';
    const signed = signedTx([1, 2, 3]);
    const deps = {
      connection: { sendRawTransaction: vi.fn().mockResolvedValue(sig) },
      jito: { submitBundle: vi.fn().mockRejectedValue(new Error('jito down')) },
      signer: { sign: vi.fn().mockResolvedValue(signed) },
    };
    vi.spyOn(w3.VersionedTransaction, 'deserialize').mockReturnValue(signed as never);

    const sub = new TxSubmitter(deps as never);
    const out = await sub.submitProtected(Buffer.from([0, 0, 0]).toString('base64'), {
      jito: true,
      tipLamports: 1000,
    });
    expect(out.txSig).toBe(sig);
    expect(out.bundleId).toBeUndefined();
    expect(deps.jito.submitBundle).toHaveBeenCalled();
    expect(deps.connection.sendRawTransaction).toHaveBeenCalled();
  });

  it('returns the transaction signature, NOT the Jito bundle id', async () => {
    const bundleId = 'BUNDLE-ABC';
    const signed = signedTx([4, 5, 6]);
    const deps = {
      connection: { sendRawTransaction: vi.fn() },
      jito: { submitBundle: vi.fn().mockResolvedValue(bundleId) },
      signer: { sign: vi.fn().mockResolvedValue(signed) },
    };
    vi.spyOn(w3.VersionedTransaction, 'deserialize').mockReturnValue(signed as never);

    const sub = new TxSubmitter(deps as never);
    const out = await sub.submitProtected(Buffer.from([0]).toString('base64'), {
      jito: true,
      tipLamports: 5000,
    });
    // The bundle id is NOT resolvable by getSignatureStatus — returning it made every
    // successful Jito swap look like a timeout and get resubmitted.
    expect(out.txSig).toBe(EXPECTED_SIG);
    expect(out.txSig).not.toBe(bundleId);
    expect(out.bundleId).toBe(bundleId);
    expect(deps.connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(deps.jito.submitBundle).toHaveBeenCalledWith(
      [Buffer.from(new Uint8Array([4, 5, 6])).toString('base64')],
      5000,
    );
  });

  it('skips Jito entirely when opts.jito is false', async () => {
    const sig = 'DIRECT-SIG';
    const signed = signedTx([7, 8, 9]);
    const deps = {
      connection: { sendRawTransaction: vi.fn().mockResolvedValue(sig) },
      jito: { submitBundle: vi.fn() },
      signer: { sign: vi.fn().mockResolvedValue(signed) },
    };
    vi.spyOn(w3.VersionedTransaction, 'deserialize').mockReturnValue(signed as never);

    const sub = new TxSubmitter(deps as never);
    const out = await sub.submitProtected(Buffer.from([0]).toString('base64'), {
      jito: false,
      tipLamports: 0,
    });
    expect(out.txSig).toBe(sig);
    expect(deps.jito.submitBundle).not.toHaveBeenCalled();
    expect(deps.connection.sendRawTransaction).toHaveBeenCalled();
  });

  it('refuses to submit a transaction that carries no usable signature', async () => {
    const signed = { serialize: () => new Uint8Array([1]), signatures: [new Uint8Array(64)] };
    const deps = {
      connection: { sendRawTransaction: vi.fn() },
      jito: { submitBundle: vi.fn() },
      signer: { sign: vi.fn().mockResolvedValue(signed) },
    };
    vi.spyOn(w3.VersionedTransaction, 'deserialize').mockReturnValue(signed as never);

    const sub = new TxSubmitter(deps as never);
    await expect(sub.submitProtected(Buffer.from([0]).toString('base64'), {
      jito: true, tipLamports: 0,
    })).rejects.toThrow(/signature/i);
    // Nothing may be broadcast if we could not have tracked it.
    expect(deps.jito.submitBundle).not.toHaveBeenCalled();
    expect(deps.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});
