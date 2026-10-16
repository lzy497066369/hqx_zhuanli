import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  // These suites require the separate offline configs and an external artifact
  // directory with the network guard installed; they cannot run in the UI suite.
  testIgnore: [
    '**/admin-workspace.spec.ts',
    '**/mysql-workspace.spec.ts',
    '**/auth-workspace.spec.ts',
    '**/private-workspaces.spec.ts',
    "**/utility-phase17-evidence.spec.ts",
    "**/utility-responses-stage-boundary.spec.ts",
    "**/phase16f-query-coverage.spec.ts",
  ],
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: process.env.PLAYWRIGHT_CHANNEL,
        viewport: { width: 1440, height: 1080 },
      },
    },
  ],
  webServer: {
    // Legacy browser-storage regression suite; real MySQL uses its isolated suite.
    env: { STORAGE_DRIVER: 'indexeddb', AUTH_REQUIRED: 'false' },
    command: "npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
