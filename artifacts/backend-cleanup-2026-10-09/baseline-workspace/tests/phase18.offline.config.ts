import { resolve } from 'node:path';
import { defineConfig } from '@playwright/test';
const artifacts = process.env.PHASE16B_ARTIFACT_DIR;
if (process.env.PHASE10_MODE !== 'local' || !artifacts || resolve(artifacts).startsWith(process.cwd()) ||
    !process.env.NODE_OPTIONS?.includes('offlineNetworkGuard.mjs')) throw new Error('PHASE18_OFFLINE_GUARD_REQUIRED');
export default defineConfig({
  testDir: '.', testMatch: ['utility-phase18-boundaries.spec.ts', 'utility-phase17-evidence.spec.ts',
    'utility-responses-diagnostics.spec.ts', 'utility-responses-stage-boundary.spec.ts'],
  testIgnore: ['live-*.spec.ts'], retries: 0, workers: 1, fullyParallel: false,
  reporter: [['list'], ['json', { outputFile: resolve(artifacts, 'results.json') }]],
  outputDir: resolve(artifacts, 'test-results'), use: { trace: 'off', screenshot: 'off', video: 'off' },
});
