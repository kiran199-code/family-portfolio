import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false, // integration tests share one database
    testTimeout: 30000,
    env: {
      APP_SECRET: 'test-secret-0123456789abcdef',
      DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/portfolio',
      ENABLE_SCHEDULER: 'false',
      LOG_LEVEL: 'silent',
    },
  },
});
