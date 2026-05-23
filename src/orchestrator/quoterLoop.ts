import type { Logger } from '../logger.js';
import { decideQuotes, type QuoterInput, type QuoteIntent } from '../strategy/xemmQuoter.js';
import type { HedgeVenue } from '../venues/hedgeVenue.js';

export interface QuoterLoopOpts {
  cex: HedgeVenue;
  store: {
    insertBasisSample(r: { t: string; raydiumMidUsd: string; krakenBid: string; krakenAsk: string; solUsd: string; wouldHaveActed: boolean }): void;
    insertOrder(r: { clOrdId: string; krakenTxid: string; side: 'buy'|'sell'; price: string; volume: string; status: 'open'; placedAt: string; lastUpdated: string }): void;
    getFlag(k: string): string | null;
  };
  readInputs: () => Promise<QuoterInput>;
  logger: Logger;
}

export class QuoterLoop {
  constructor(private o: QuoterLoopOpts) {}
  async tick(): Promise<void> {
    if (this.o.store.getFlag('degraded') === '1') {
      this.o.logger.info('quoter: degraded, skipping');
      return;
    }
    const input = await this.o.readInputs();
    const intents = decideQuotes(input);
    const now = new Date().toISOString();
    const topBid = input.krakenBook.bids[0]?.price;
    const topAsk = input.krakenBook.asks[0]?.price;
    if (topBid !== undefined && topAsk !== undefined) {
      this.o.store.insertBasisSample({
        t: now, raydiumMidUsd: input.ref.raydiumMidUsd.toString(),
        krakenBid: topBid.toString(), krakenAsk: topAsk.toString(), solUsd: input.ref.solUsd.toString(),
        wouldHaveActed: intents.some(i => i.action === 'place'),
      });
    } else {
      this.o.logger.warn('quoter: book incomplete, skipping basis sample');
    }
    for (const intent of intents) await this.dispatch(intent, now);
  }
  private async dispatch(intent: QuoteIntent, now: string): Promise<void> {
    try {
      if (intent.action === 'place') {
        const txid = await this.o.cex.placeLimit({
          side: intent.side, price: intent.price, volume: intent.volume,
          postOnly: true, clOrdId: intent.clOrdId,
        });
        this.o.store.insertOrder({
          clOrdId: intent.clOrdId, krakenTxid: txid, side: intent.side,
          price: intent.price.toString(), volume: intent.volume.toString(),
          status: 'open', placedAt: now, lastUpdated: now,
        });
      } else if (intent.action === 'amend') {
        const amendParams: Parameters<typeof this.o.cex.amend>[0] = {
          venueOrderId: intent.venueOrderId, deadlineSec: 10,
        };
        if (intent.price !== undefined) amendParams.price = intent.price;
        if (intent.volume !== undefined) amendParams.volume = intent.volume;
        await this.o.cex.amend(amendParams);
      } else if (intent.action === 'cancel') {
        await this.o.cex.cancel(intent.venueOrderId);
      }
    } catch (err) {
      this.o.logger.error({ err, intent }, 'quoter: dispatch failed');
    }
  }
}
