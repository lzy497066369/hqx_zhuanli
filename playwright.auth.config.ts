import { defineConfig, devices } from '@playwright/test';
process.env.AUTH_TEST_WORKSPACE_ID ||= `auth-browser-test-${Date.now()}`;
export default defineConfig({
  testDir: './tests', testMatch: ['auth-workspace.spec.ts','private-workspaces.spec.ts'], workers: 1, timeout: 60000,
  outputDir: 'test-results/auth',
  reporter: [['list']], use: { baseURL: 'http://127.0.0.1:5210', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.platform === 'win32' ? 'msedge' : undefined } }],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5210 --strictPort', url: 'http://127.0.0.1:5210', reuseExistingServer: false,
    env: { AUTH_REQUIRED: 'true', STORAGE_DRIVER: 'mysql', MYSQL_WORKSPACE_ID: process.env.AUTH_TEST_WORKSPACE_ID },
  },
});
