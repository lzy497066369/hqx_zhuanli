import { defineConfig } from '@playwright/test';
import config from '../../playwright.product.config';

export default defineConfig({
  ...config,
  testDir: '../../tests',
  testMatch: ['product-workflow-ui.spec.ts', 'workspace.spec.ts'],
  workers: 1,
  timeout: 90000,
  reporter: [['list']],
  outputDir: './test-results',
  use: { ...config.use, baseURL: 'http://127.0.0.1:5217' },
  webServer: { env: { STORAGE_DRIVER: 'indexeddb', AUTH_REQUIRED: 'false' }, command: 'npm run dev -- --host 127.0.0.1 --port 5217 --strictPort', url: 'http://127.0.0.1:5217', reuseExistingServer: false },
});
