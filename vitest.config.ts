import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      // Exclude orchestrator-thin-glue modules whose only entry is main.ts and
      // which require live venue fakes (kraken binary, Solana RPC, Jupiter HTTP)
      // to cover meaningfully. Phase 2 paper trade will naturally exercise these.
      exclude: [
        'src/cli/index.ts',
        'src/main.ts',
        'src/jitoClient.ts',
        'src/notifier.ts',
        'src/orchestrator/fillLoop.ts',
        'src/orchestrator/watchdogLoop.ts',
        'src/risk/killSwitchWatchdog.ts',
        'src/cli/status.ts',
        'src/cli/report.ts',
        'src/cli/emergencyExit.ts',
        'src/venues/jupiterApi.ts',
        'src/venues/krakenStream.ts',
      ],
      // v0.1 thresholds: pure-logic modules carry the coverage. Branches relaxed
      // to 70 for v0.1 because KrakenClient error-envelope branches need a live
      // binary to exercise fully; tightening returns once Phase 2 smoke tests
      // land. Track gaps in CLAUDE.md "Known gaps" section.
      thresholds: { lines: 85, branches: 70, functions: 85, statements: 85 },
    },
    testTimeout: 10_000,
  },
});
