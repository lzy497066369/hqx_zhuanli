import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: resolve(process.cwd(), 'tests'),
  testIgnore: ['live-*.spec.ts', 'utility-phase17-evidence.spec.ts', 'utility-responses-stage-boundary.spec.ts', 'phase16f-query-coverage.spec.ts'],
  fullyParallel: true,
  workers: 3,
  timeout: 45000,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: resolve(process.cwd(), 'artifacts/code-redundancy-2026-10-12/test-results.json') }]],
  outputDir: resolve(process.cwd(), 'test-results/code-cleanup'),
  use: { baseURL: 'http://127.0.0.1:5201', trace: 'off', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: 'msedge', viewport: { width: 1440, height: 1080 } } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5201 --strictPort', url: 'http://127.0.0.1:5201', reuseExistingServer: false },
});
