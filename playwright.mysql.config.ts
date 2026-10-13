import { defineConfig, devices } from '@playwright/test';
process.env.MYSQL_TEST_WORKSPACE_ID ||= `browser-test-${Date.now()}`;
export default defineConfig({
  testDir: './tests', testMatch: 'mysql-workspace.spec.ts', workers: 1,
  outputDir: 'test-results/mysql',
  reporter: [['list']], timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:5209', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.platform === 'win32' ? 'msedge' : undefined } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5209 --strictPort',
    url: 'http://127.0.0.1:5209', reuseExistingServer: false,
    env: { STORAGE_DRIVER: 'mysql', AUTH_REQUIRED: 'false', MYSQL_WORKSPACE_ID: process.env.MYSQL_TEST_WORKSPACE_ID },
  },
});
