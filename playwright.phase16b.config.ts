import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const artifacts = process.env.PHASE16B_ARTIFACT_DIR;
if (process.env.PHASE10_MODE !== 'local') throw new Error('PHASE16B_REQUIRES_LOCAL_MODE');
if (!artifacts || resolve(artifacts) === process.cwd() || resolve(artifacts).startsWith(`${process.cwd()}/`)) throw new Error('EXTERNAL_ARTIFACT_DIR_REQUIRED');
if (!process.env.NODE_OPTIONS?.includes('offlineNetworkGuard.mjs')) throw new Error('PHASE16B_NETWORK_GUARD_REQUIRED');
export default defineConfig({
  testDir: './tests', testMatch: 'utility-responses-diagnostics.spec.ts', testIgnore: ['live-*.spec.ts'],
  retries: 0, workers: 1, fullyParallel: false, reporter: [['list']],
  outputDir: resolve(artifacts, 'test-results'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
