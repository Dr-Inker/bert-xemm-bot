import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { StateStore } from '../stateStore.js';
import { runPause } from './pause.js';
import { runResume } from './resume.js';
import { runStatus } from './status.js';

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

await program.parseAsync(process.argv);
