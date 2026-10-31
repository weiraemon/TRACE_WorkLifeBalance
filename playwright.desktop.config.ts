import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/desktop',
  timeout: 60000,
  expect: { timeout: 10000 },
  workers: 1,
  reporter: [['list']],
});
