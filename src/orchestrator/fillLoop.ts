import type { Logger } from '../logger.js';
import type { HedgeVenue } from '../venues/hedgeVenue.js';
import type { HedgeExecutor } from '../strategy/hedgeExecutor.js';

export class FillLoop {
  private stop = false;
  constructor(private cex: HedgeVenue, private exec: HedgeExecutor, private logger: Logger) {}
  async run(): Promise<void> {
    for await (const fill of this.cex.watchExecutions()) {
      if (this.stop) break;
      try { await this.exec.onFill(fill); }
      catch (err) { this.logger.error({ err, fillId: fill.fillId }, 'fillLoop: onFill failed'); }
    }
  }
  shutdown(): void { this.stop = true; }
}
