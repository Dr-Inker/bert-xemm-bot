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
      exclude: ['src/cli/index.ts', 'src/main.ts'],
      thresholds: { lines: 85, branches: 75, functions: 85, statements: 85 },
    },
    testTimeout: 10_000,
  },
});
