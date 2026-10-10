import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['product-workflow*.spec.ts'], fullyParallel: true, workers: 3,
  timeout: 45000, reporter: [['list'], ['html', { outputFolder: 'playwright-report/product-workflow', open: 'never' }]],
  outputDir: 'test-results/product-workflow',
  use: { baseURL: 'http://127.0.0.1:5198', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), viewport: { width: 1440, height: 1080 } } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5198 --strictPort', url: 'http://127.0.0.1:5198', reuseExistingServer: false },
});
