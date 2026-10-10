import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

// Reuse the Phase 16B network guard's external artifact setting.
const artifacts = process.env.PHASE16B_ARTIFACT_DIR;
if (process.env.PHASE10_MODE !== 'local') throw new Error('PHASE16D_REQUIRES_LOCAL_MODE');
if (!artifacts || resolve(artifacts) === process.cwd() || resolve(artifacts).startsWith(`${process.cwd()}/`)) throw new Error('EXTERNAL_ARTIFACT_DIR_REQUIRED');
if (!process.env.NODE_OPTIONS?.includes('offlineNetworkGuard.mjs')) throw new Error('PHASE16D_NETWORK_GUARD_REQUIRED');
export default defineConfig({
  testDir: './tests', testMatch: 'utility-responses-stage-boundary.spec.ts', testIgnore: ['live-*.spec.ts'],
  retries: 0, workers: 1, fullyParallel: false, reporter: [['list']],
  outputDir: resolve(artifacts, 'test-results'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
