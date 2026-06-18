const { defineConfig, devices } = require('@playwright/test');
const { execSync } = require('child_process');
const { existsSync } = require('fs');
const path = require('path');

// Build the libasound stub if missing (needed on systems without libasound2 installed)
if (!existsSync('/tmp/libasound.so.2')) {
  execSync(`node ${path.join(__dirname, '.claude/skills/run-pos-system/build-libasound-stub.mjs')}`);
}

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3001',
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
      env: { ...process.env, LD_LIBRARY_PATH: '/tmp' },
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server.js',
    url: 'http://localhost:3001',
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
