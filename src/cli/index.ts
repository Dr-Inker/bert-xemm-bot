import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { StateStore } from '../stateStore.js';
import { runPause } from './pause.js';
import { runResume } from './resume.js';
import { runStatus } from './status.js';
import { runBasisSnapshot } from './basisSnapshot.js';
import { runReport } from './report.js';

const program = new Command();
program.name('bert-xemm').description('bert-xemm-bot operator CLI');

program
  .command('pause')
  .description('Set degraded=1 to halt the quoter')
  .option('--config <path>', 'config path', '/etc/bert-xemm-bot/config.yaml')
  .action((opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const store = new StateStore(cfg.paths.state);
    runPause(store);
  });

program
  .command('resume')
  .description('Clear degraded flag and emergency_unwind_complete')
  .option('--config <path>', 'config path', '/etc/bert-xemm-bot/config.yaml')
  .action((opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const store = new StateStore(cfg.paths.state);
    runResume(store);
  });

program
  .command('status')
  .description('Print current state JSON')
  .option('--config <path>', 'config path', '/etc/bert-xemm-bot/config.yaml')
  .action((opts: { config: string }) => {
    const cfg = loadConfig(opts.config);
    const store = new StateStore(cfg.paths.state);
    runStatus(store, () => ({
      degraded: store.getFlag('degraded'),
      openOrderCount: 0,
      recentBasisCount: 0,
      lastFillT: null,
    }));
  });

program.command('basis-snapshot')
  .description('Export basis_samples since a date as CSV')
  .requiredOption('--since <iso>', 'ISO timestamp lower bound')
  .option('--config <path>', 'config path', '/etc/bert-xemm-bot/config.yaml')
  .action((opts: { since: string; config: string }) => {
    const cfg = loadConfig(opts.config);
    const store = new StateStore(cfg.paths.state);
    runBasisSnapshot(store, opts.since);
  });

program.command('report')
  .description('Print summary report since a date')
  .requiredOption('--since <iso>', 'ISO timestamp lower bound')
  .option('--config <path>', 'config path', '/etc/bert-xemm-bot/config.yaml')
  .action((opts: { since: string; config: string }) => {
    const cfg = loadConfig(opts.config);
    const store = new StateStore(cfg.paths.state);
    runReport(store, opts.since);
  });

program.command('emergency-exit')
  .description('Cancel all and drain BERT to SOL; halts the bot')
  .option('--config <path>', 'config path', '/etc/bert-xemm-bot/config.yaml')
  .action(async (_opts: { config: string }) => {
    // venue wiring deferred — same pattern as scripts/emergency-exit.ts; copy from main.ts when consolidated.
    console.error('emergency-exit: wire venues from config (see Task 23 / src/main.ts) and call runEmergencyExitCli');
    process.exit(2);
  });

await program.parseAsync(process.argv);
