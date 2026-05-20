import { loadConfig } from '../src/config.js';
import { logger } from '../src/logger.js';

const cfg = loadConfig(process.env.CONFIG_PATH ?? '/etc/bert-xemm-bot/config.yaml');
logger.warn({ mode: cfg.mode }, 'emergency-exit invoked from script wrapper');
// Implementer wires venues + store + notifier from config — same pattern as src/main.ts (Task 23).
// Once that wiring lands: import runEmergencyUnwind from '../src/risk/emergencyUnwind.js' and call it.
logger.warn('emergency-exit wrapper: venue wiring not implemented in v0; copy from src/main.ts when it lands (Task 23)');
process.exit(2);
