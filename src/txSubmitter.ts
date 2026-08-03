import { Connection, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { JitoClient } from './jitoClient.js';
import { logger } from './logger.js';

export interface TxSubmitterDeps {
  connection: Connection;
  jito: JitoClient;
  signer: { sign(tx: VersionedTransaction): Promise<VersionedTransaction> };
}

/**
 * Outcome of a protected submission.
 *
 * `txSig` is the Solana transaction signature — the ONLY value `getSignatureStatus`
 * can resolve. `bundleId` is Jito's bundle handle, useful for support/debugging but
 * meaningless to confirmation polling; returning it as if it were a signature made
 * every successful Jito swap look like a timeout and get resubmitted.
 */
export interface SubmitResult {
  txSig: string;
  bundleId?: string;
}

/** First signature of a signed tx, base58-encoded — the canonical Solana tx id. */
function txSignature(signed: VersionedTransaction): string {
  const sig = signed.signatures?.[0];
  if (!sig || sig.length === 0 || sig.every(b => b === 0)) {
    throw new Error('txSubmitter: refusing to submit — signed transaction carries no signature');
  }
  return bs58.encode(sig);
}

/**
 * Jito-first submitter with public-RPC fallback.
 *
 * Routes signed transactions through the Jito Block Engine (private
 * mempool, no sandwich/frontrun exposure) by default; falls back to
 * regular RPC submission if Jito throws or `opts.jito` is false.
 *
 * Used by RaydiumAmmClient.submitSwap and any other path that crosses
 * thin pool liquidity.
 */
export class TxSubmitter {
  constructor(private deps: TxSubmitterDeps) {}

  async submitProtected(
    serializedTxBase64: string,
    opts: { jito: boolean; tipLamports: number },
  ): Promise<SubmitResult> {
    const buf = Buffer.from(serializedTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    const signed = await this.deps.signer.sign(tx);

    // Derive the signature BEFORE broadcasting: if we could not track the transaction
    // we must not send it, or a confirmed swap becomes invisible to the hedge path.
    const txSig = txSignature(signed);
    const wireBase64 = Buffer.from(signed.serialize()).toString('base64');

    if (opts.jito) {
      try {
        const bundleId = await this.deps.jito.submitBundle([wireBase64], opts.tipLamports);
        return { txSig, bundleId };
      } catch (e) {
        logger.warn({ err: e, txSig }, 'jito submission failed — falling back to public RPC');
        /* fall through to public RPC */
      }
    }

    const rpcSig = await this.deps.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
    return { txSig: rpcSig };
  }
}
