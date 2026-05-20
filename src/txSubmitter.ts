import { Connection, VersionedTransaction } from '@solana/web3.js';
import { JitoClient } from './jitoClient.js';
import { logger } from './logger.js';

export interface TxSubmitterDeps {
  connection: Connection;
  jito: JitoClient;
  signer: { sign(tx: VersionedTransaction): Promise<VersionedTransaction> };
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
  ): Promise<string> {
    const buf = Buffer.from(serializedTxBase64, 'base64');
    const tx = VersionedTransaction.deserialize(buf);
    const signed = await this.deps.signer.sign(tx);
    const wireBase64 = Buffer.from(signed.serialize()).toString('base64');

    if (opts.jito) {
      try {
        return await this.deps.jito.submitBundle([wireBase64], opts.tipLamports);
      } catch (e) {
        logger.warn({ err: e }, 'jito submission failed — falling back to public RPC');
        /* fall through to public RPC */
      }
    }

    return this.deps.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: false,
    });
  }
}
