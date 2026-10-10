import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '../../tests',
  testMatch: ['utility-materials-v2-api.spec.ts', 'utility-generation-context.spec.ts', 'utility-ai-server.spec.ts', 'utility-concept-server.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, timeout: 60000,
  reporter: [['list'], ['json', {outputFile: './artifacts/backend-cleanup-2026-10-09/test-results.json'}]],
  outputDir: './test-output',
  use: {trace: 'off', screenshot: 'off', video: 'off'},
});
