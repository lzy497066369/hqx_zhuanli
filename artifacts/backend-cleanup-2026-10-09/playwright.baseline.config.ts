import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './baseline-workspace/tests', testMatch: ['utility-ai-server.spec.ts'],
  workers: 1, fullyParallel: false, retries: 0, timeout: 60000,
  reporter: [['list'], ['json', {outputFile: './artifacts/backend-cleanup-2026-10-09/baseline-test-results.json'}]],
  outputDir: './baseline-test-output', use: {trace: 'off', screenshot: 'off', video: 'off'},
});
