import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'capture.spec.ts', timeout: 120000, workers: 1, retries: 0,
  reporter: [['list']], outputDir: './browser-results',
  use: {baseURL:'http://127.0.0.1:5187',channel:'msedge',headless:true,viewport:{width:1440,height:1000},deviceScaleFactor:1,locale:'zh-CN',timezoneId:'Asia/Hong_Kong',reducedMotion:'reduce',screenshot:'only-on-failure',trace:'retain-on-failure'},
});
