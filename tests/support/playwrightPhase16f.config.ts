import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';

const artifacts = process.env.PHASE16B_ARTIFACT_DIR;
if (process.env.PHASE10_MODE !== 'local') throw new Error('PHASE16F_REQUIRES_LOCAL_MODE');
if (!artifacts || resolve(artifacts) === process.cwd() || resolve(artifacts).startsWith(`${process.cwd()}/`)) {
  throw new Error('EXTERNAL_ARTIFACT_DIR_REQUIRED');
}
if (!process.env.NODE_OPTIONS?.includes('offlineNetworkGuard.mjs')) throw new Error('PHASE16F_NETWORK_GUARD_REQUIRED');

export default defineConfig({
  testDir: '..',
  testMatch: ['phase16f-query-coverage.spec.ts', 'utility-responses-stage-boundary.spec.ts'],
  testIgnore: ['live-*.spec.ts'],
  // The existing guard self-test intentionally attempts connections. This phase requires zero attempts.
  grepInvert: /network guard blocks all external paths before native dispatch/,
  retries: 0, workers: 1, fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: resolve(artifacts, 'offline-tests.json') }]],
  outputDir: resolve(artifacts, 'test-results'),
  use: { trace: 'off', screenshot: 'off', video: 'off' },
});
