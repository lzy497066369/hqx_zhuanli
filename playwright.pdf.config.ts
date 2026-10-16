import { defineConfig, devices } from '@playwright/test';

const browser = { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined), viewport: { width: 1440, height: 1080 } };

export default defineConfig({
  testDir: './tests', fullyParallel: true, workers: 2, timeout: 60000,
  outputDir: 'test-results/pdf-export',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report/pdf-export', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:5267', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'pdf', testMatch: ['product-workflow-pdf.spec.ts', 'utility-word-layout.spec.ts', 'invention-word.spec.ts'], use: browser },
    { name: 'word-regression', testMatch: 'product-workflow-ui.spec.ts', grep: /Word 只含|可变附图清单|非安全.*crypto.subtle|移动端无横向/, use: browser },
  ],
  webServer: {
    env: { STORAGE_DRIVER: 'indexeddb', AUTH_REQUIRED: 'false' },
    command: 'npm run dev -- --host 127.0.0.1 --port 5267 --strictPort',
    url: 'http://127.0.0.1:5267', reuseExistingServer: false,
  },
});
