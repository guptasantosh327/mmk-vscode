import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
