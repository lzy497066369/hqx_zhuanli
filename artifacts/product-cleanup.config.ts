import { defineConfig } from '@playwright/test';
import config from '../playwright.product.config';

export default defineConfig({
  ...config,
  testDir: '../tests',
  workers: 1,
  reporter: [['list']],
  outputDir: '../test-results/product-cleanup',
  use: { ...config.use, baseURL: 'http://127.0.0.1:5218' },
  webServer: {
    env: { STORAGE_DRIVER: 'indexeddb', AUTH_REQUIRED: 'false' },
    command: 'npm run dev -- --host 127.0.0.1 --port 5218 --strictPort',
    url: 'http://127.0.0.1:5218',
    reuseExistingServer: false,
  },
});
