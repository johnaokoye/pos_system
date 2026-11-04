const { defineConfig, devices } = require('@playwright/test');
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

// Build the libasound stub if missing (needed on systems without libasound2 installed)
if (!existsSync('/tmp/libasound.so.2')) {
  execSync(`node ${path.join(__dirname, '.claude/skills/run-pos-system/build-libasound-stub.mjs')}`);
}

// Tests get their own server and throwaway database (tests/support/start-server.js).
// reuseExistingServer stays off so a run can never land on a server with real data.
const PORT = process.env.POS_TEST_PORT || '3101';
process.env.POS_TEST_PORT = PORT;
const BASE_URL = `http://localhost:${PORT}`;
process.env.POS_TEST_URL = BASE_URL;

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  workers: 2,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      env: { ...process.env, LD_LIBRARY_PATH: '/tmp' },
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node tests/support/start-server.js',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
