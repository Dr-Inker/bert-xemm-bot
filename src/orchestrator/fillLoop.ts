import type Decimal from 'decimal.js';
import type { Logger } from '../logger.js';
import type { HedgeVenue } from '../venues/hedgeVenue.js';
import type { HedgeExecutor } from '../strategy/hedgeExecutor.js';

export class FillLoop {
  private stop = false;
  constructor(
    private cex: HedgeVenue,
    private exec: HedgeExecutor,
    private logger: Logger,
    private solUsdProvider: () => Promise<Decimal>,
  ) {}
  async run(): Promise<void> {
    for await (const fill of this.cex.watchExecutions()) {
      if (this.stop) break;
      try {
        const solUsd = await this.solUsdProvider();
        await this.exec.onFill(fill, solUsd);
      }
      catch (err) { this.logger.error({ err, fillId: fill.fillId }, 'fillLoop: onFill failed'); }
    }
  }
  shutdown(): void { this.stop = true; }
}
