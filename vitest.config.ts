import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/api/test/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
