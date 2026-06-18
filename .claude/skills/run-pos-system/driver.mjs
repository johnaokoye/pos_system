/**
 * POS System browser driver.
 * Usage: node .claude/skills/run-pos-system/driver.mjs [screenshot-dir]
 *
 * Starts the server if not already running, logs in as admin, navigates
 * to every major section, and writes screenshots to SHOTS_DIR.
 */
import { chromium } from '@playwright/test';
import { mkdir, access } from 'fs/promises';
import { spawn, execSync } from 'child_process';
import { join } from 'path';

const PORT = 3001;
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.argv[2] ?? '/tmp/pos-shots';

await mkdir(SHOTS, { recursive: true });

// --- Server lifecycle ---

async function serverUp() {
  try {
    const r = await fetch(`${BASE}/api/products`);
    return r.ok;
  } catch { return false; }
}

let serverProc = null;
if (!await serverUp()) {
  console.log('Starting server…');
  serverProc = spawn('node', ['server.js'], {
    cwd: new URL('../../..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', d => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', d => process.stderr.write('[server] ' + d));
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await serverUp()) break;
    await new Promise(r => setTimeout(r, 500));
  }
  if (!await serverUp()) throw new Error('Server did not start in 15 s');
  console.log('Server up.');
}

// --- libasound.so.2 stub check ---
// This system lacks ALSA. The stub must exist at /tmp/libasound.so.2.
// Build it with: node .claude/skills/run-pos-system/build-libasound-stub.mjs
const STUB = '/tmp/libasound.so.2';
try { await access(STUB); }
catch {
  console.log('Building libasound stub…');
  execSync(`node ${new URL('build-libasound-stub.mjs', import.meta.url).pathname}`);
}

// --- Browser ---

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: '/tmp' },
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

async function ss(name) {
  const p = join(SHOTS, name);
  await page.screenshot({ path: p });
  console.log('  screenshot ->', p);
}

async function nav(section) {
  await page.click(`[data-section="${section}"]`);
  await page.waitForTimeout(1000);
}

// --- Login ---

await page.goto(BASE);
await page.waitForLoadState('networkidle');
await ss('01-login.png');

await page.fill('#login-user', 'admin');
await page.fill('#login-pass', '123456');
await page.click('button.login-btn');
await page.waitForTimeout(2500);
await ss('02-dashboard.png');
console.log('Logged in.');

// --- Navigate representative sections ---

await nav('pos');
// Dismiss the "Open Cash Drawer" modal if it appears
const skip = page.locator('button:has-text("Skip")');
if (await skip.isVisible().catch(() => false)) await skip.click();
await page.waitForTimeout(500);
await ss('03-pos.png');

await nav('inventory');
await page.waitForTimeout(800);
await ss('04-inventory.png');

await nav('customers');
await page.waitForTimeout(800);
await ss('05-customers.png');

await nav('purchasing');
await page.waitForTimeout(800);
await ss('06-purchasing.png');

// --- Done ---

await browser.close();
if (serverProc) serverProc.kill();
console.log(`\nDone. ${SHOTS}/`);
