import { defineConfig, devices } from '@playwright/test';
import { ORIGINS, PORTS } from './tests/e2e/ports';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /(?:pdf-import|sidebar|sites-static)\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: 'list',
  use: { baseURL: ORIGINS.preview, channel: 'chrome', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'sites-desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } }, grep: /^(?!.*@mobile)/ },
    { name: 'sites-mobile', use: { ...devices['Pixel 7'], channel: 'chrome' }, grep: /@mobile/ },
  ],
  webServer: {
    command: `pnpm build:sites --outDir .scratch/sites-dist && pnpm exec vite preview --mode sites --outDir .scratch/sites-dist --host 127.0.0.1 --port ${PORTS.preview} --strictPort`,
    url: ORIGINS.preview,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
