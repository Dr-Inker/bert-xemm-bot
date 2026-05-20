import type { Logger } from '../logger.js';
import type { KillSwitchWatchdog } from '../risk/killSwitchWatchdog.js';

export class WatchdogLoop {
  private timer: NodeJS.Timeout | null = null;
  constructor(private watchdog: KillSwitchWatchdog, private cadenceMs: number, private logger: Logger) {}
  start(): void {
    this.timer = setInterval(() => {
      this.watchdog.tick().catch(err => this.logger.error({ err }, 'watchdog: tick failed'));
    }, this.cadenceMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
