import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', testMatch: 'sites-chatgpt.spec.ts', workers: 1,
  timeout: 60_000, use: { browserName: 'chromium', channel: 'chrome', headless: true },
  reporter: 'list', outputDir: 'test-results/sites-server',
});
