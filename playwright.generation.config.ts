import { defineConfig } from '@playwright/test';
import product from './playwright.product.config';

export default defineConfig({
  ...product,
  testMatch: ['generation-queue.spec.ts', 'utility-ai-server.spec.ts', 'utility-materials-v2-api.spec.ts', 'product-workflow-api.spec.ts', 'product-workflow-ui.spec.ts'],
  reporter: [['list']],
  outputDir: 'test-results/generation',
});
