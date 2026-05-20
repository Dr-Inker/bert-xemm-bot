import type { HedgeVenue } from '../venues/hedgeVenue.js';

export interface ReconcilerOpts {
  cex: HedgeVenue;
  store: { listOpenOrders(): Promise<{ venueOrderId: string }[]>; setFlag(k: string, v: string): void };
  notifier: { page(msg: string): void };
}

export class Reconciler {
  constructor(private opts: ReconcilerOpts) {}
  async run(): Promise<boolean> {
    const venueOpen = await this.opts.cex.openOrders();
    const dbOpen = await this.opts.store.listOpenOrders();
    const venueSet = new Set(venueOpen.map(o => o.venueOrderId));
    const dbSet = new Set(dbOpen.map(o => o.venueOrderId));
    const onlyInDb = [...dbSet].filter(x => !venueSet.has(x));
    const onlyOnVenue = [...venueSet].filter(x => !dbSet.has(x));
    if (onlyInDb.length || onlyOnVenue.length) {
      this.opts.store.setFlag('degraded', '1');
      this.opts.notifier.page(`reconciler: orders mismatch onlyInDb=${onlyInDb.join(',')} onlyOnVenue=${onlyOnVenue.join(',')}`);
      return false;
    }
    return true;
  }
}
