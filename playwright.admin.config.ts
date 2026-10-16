import { defineConfig, devices } from '@playwright/test';
import { loadEnv } from 'vite';
for (const [key, value] of Object.entries(loadEnv('development', process.cwd(), ''))) if (key.startsWith('MYSQL_') && process.env[key] === undefined) process.env[key] = value;
const database = process.env.ADMIN_TEST_DATABASE || 'zhichuang_admin_test';
if (!/^zhichuang_admin_test[a-z0-9_]*$/.test(database)) throw new Error('Use an isolated admin test database');
export default defineConfig({
  testDir: './tests', testMatch: ['admin-workspace.spec.ts'], workers: 1, timeout: 60000,
  outputDir: 'test-results/admin', reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5214', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.platform === 'win32' ? 'msedge' : undefined, viewport: { width: 1440, height: 1000 } } }],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 5214 --strictPort', url: 'http://127.0.0.1:5214', reuseExistingServer: false, env: { AUTH_REQUIRED: 'true', STORAGE_DRIVER: 'mysql', MYSQL_DATABASE: database } },
});
