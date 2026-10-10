import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const mode = process.env.PHASE10_MODE || 'local';
const artifacts = process.env.PHASE10_ARTIFACT_DIR;
if (!artifacts || resolve(artifacts) === process.cwd() || resolve(artifacts).startsWith(`${process.cwd()}/`)) throw new Error('EXTERNAL_ARTIFACT_DIR_REQUIRED');
if (!['real', 'strict-local', 'local'].includes(mode)) throw new Error('INVALID_PHASE10_MODE');
const real = mode === 'real';
const port = Number(process.env.PHASE10_PORT || 5198);
export default defineConfig({
  testDir: './tests',
  testMatch: real ? 'live-research-word.spec.ts' : mode === 'strict-local' ? 'utility-strict-e2e.spec.ts' : '**/*.spec.ts',
  testIgnore: real ? [] : ['live-*.spec.ts'],
  retries: 0, workers: 1, fullyParallel: false,
  reporter: [['list']], outputDir: resolve(artifacts, 'test-results'),
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PLAYWRIGHT_CHANNEL, viewport: { width: 1440, height: 1080 } } }],
  webServer: { command: 'node tests/support/phase10Server.mjs', url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false, stdout: 'ignore', stderr: 'ignore', timeout: 60_000 },
});
