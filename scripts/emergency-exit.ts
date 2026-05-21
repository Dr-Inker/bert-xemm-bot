import Decimal from 'decimal.js';
import { wireVenues } from '../src/orchestrator/wire.js';
import { runEmergencyUnwind } from '../src/risk/emergencyUnwind.js';
import { logger } from '../src/logger.js';

const { cfg, cex, dex, store, notifier } = wireVenues(process.env['CONFIG_PATH']);
logger.warn({ mode: cfg.mode }, 'emergency-exit: starting unwind');
await runEmergencyUnwind({
  cex, dex,
  notifier: { page: (m) => { void notifier.critical(m); } },
  store: { setFlag: (k, v) => store.setFlag(k, v) },
  minOrderBert: new Decimal('380'),
});
logger.warn('emergency-exit: unwind complete; halted with degraded=1');
