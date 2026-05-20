import { describe, it, expect, vi } from 'vitest';
import { TxSubmitter } from '../src/txSubmitter.js';
import * as w3 from '@solana/web3.js';

describe('TxSubmitter.submitProtected', () => {
  it('falls back to public RPC when Jito throws', async () => {
    const sig = 'PUBSIG';
    const signed = { serialize: () => new Uint8Array([1, 2, 3]) };
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
    expect(out).toBe(sig);
    expect(deps.jito.submitBundle).toHaveBeenCalled();
    expect(deps.connection.sendRawTransaction).toHaveBeenCalled();
  });

  it('returns Jito bundle ID on success', async () => {
    const bundleId = 'BUNDLE-ABC';
    const signed = { serialize: () => new Uint8Array([4, 5, 6]) };
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
    expect(out).toBe(bundleId);
    expect(deps.connection.sendRawTransaction).not.toHaveBeenCalled();
    expect(deps.jito.submitBundle).toHaveBeenCalledWith(
      [Buffer.from(new Uint8Array([4, 5, 6])).toString('base64')],
      5000,
    );
  });

  it('skips Jito entirely when opts.jito is false', async () => {
    const sig = 'DIRECT-SIG';
    const signed = { serialize: () => new Uint8Array([7, 8, 9]) };
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
    expect(out).toBe(sig);
    expect(deps.jito.submitBundle).not.toHaveBeenCalled();
    expect(deps.connection.sendRawTransaction).toHaveBeenCalled();
  });
});
