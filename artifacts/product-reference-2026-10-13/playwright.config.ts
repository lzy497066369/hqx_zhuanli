import { defineConfig } from '@playwright/test';
import path from 'node:path';
import productConfig from '../../playwright.product.config';

export default defineConfig({
  ...productConfig,
  testDir: path.resolve('tests'),
  outputDir: path.resolve('artifacts/product-reference-2026-10-13/test-results'),
  reporter: [['list']],
  use: { ...productConfig.use, baseURL: 'http://127.0.0.1:5207' },
  webServer: {
    env: { STORAGE_DRIVER: 'indexeddb', AUTH_REQUIRED: 'false' },
    command: 'npm run dev -- --host 127.0.0.1 --port 5207 --strictPort',
    url: 'http://127.0.0.1:5207',
    reuseExistingServer: false,
  },
});
