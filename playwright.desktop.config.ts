import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/desktop',
  outputDir: 'test-results/desktop',
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: [['list']],
});
