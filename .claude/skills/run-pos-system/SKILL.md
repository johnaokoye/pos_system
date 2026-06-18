---
name: run-pos-system
description: Build, run, and drive the RetailPOS system. Use when asked to start the app, take a screenshot, test a UI change, interact with the running app, or smoke-test the API.
---

RetailPOS is a Node.js/Express server (port 3001) serving a single-file vanilla JS SPA. Drive it with `.claude/skills/run-pos-system/driver.mjs` (Playwright) for UI work, or `curl` for API smoke-tests.

All paths below are relative to the repo root (`/home/johnokoye/pos-system/`).

## Prerequisites

`@playwright/test` is already in `devDependencies` — no extra install needed. The Playwright-managed Chromium binary lacks `libasound.so.2` on this system. The driver builds a stub automatically on first run; to rebuild it manually:

```bash
node .claude/skills/run-pos-system/build-libasound-stub.mjs
# → Built /tmp/libasound.so.2
```

Requires `as` and `ld` from binutils (present by default on Ubuntu — verified).

## Setup

```bash
npm install
```

No env vars required for local SQLite. For Turso (production):

```bash
export TURSO_DATABASE_URL=libsql://...
export TURSO_AUTH_TOKEN=...
```

## Run (agent path)

### UI driver

Launch the driver from the repo root. It starts the server if not already running, logs in as `admin`/`123456`, navigates representative sections, and writes screenshots:

```bash
node .claude/skills/run-pos-system/driver.mjs /tmp/pos-shots
```

Screenshots land at `/tmp/pos-shots/01-login.png` through `06-purchasing.png`.

To drive a specific section interactively, import and extend the driver, or add a one-off script that reuses its login sequence:

```js
import { chromium } from '@playwright/test';
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: '/tmp' },
});
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
await page.goto('http://localhost:3001');
await page.fill('#login-user', 'admin');
await page.fill('#login-pass', '123456');
await page.click('button.login-btn');
await page.waitForTimeout(2500);
// Navigate: await page.click('[data-section="pos"]');
```

### API smoke-test

The backend needs no browser. Login and query products:

```bash
# Start the server
node server.js &> /tmp/pos.log &
timeout 15 bash -c 'until curl -sf http://localhost:3001 >/dev/null; do sleep 0.5; done'

# Login
curl -sf -X POST http://localhost:3001/api/employees/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"123456"}'

# Products list
curl -sf http://localhost:3001/api/products | python3 -m json.tool | head -20

# Stop
pkill -f "node server.js"
```

## Run (human path)

```bash
npm start   # → server on :3001. Open http://localhost:3001. Ctrl-C to stop.
npm run dev # same with nodemon auto-reload
```

## Navigation

All nav items use `[data-section="<name>"]`. Available sections:

`dashboard`, `pos`, `drawers`, `customers`, `reports`, `purchasing`, `suppliers`, `inventory`, `services`, `transfers`, `quotations`, `transactions`, `accounts`, `crm`, `commissions`, `promotions`, `warehouse`, `cycle-counts`, `employees`, `branches`, `security`, `settings`, `shipping`

## Gotchas

- **`libasound.so.2` missing** — Chromium (both headless-shell and full) fails with `error while loading shared libraries: libasound.so.2`. The stub builder (`build-libasound-stub.mjs`) generates a versioned ELF stub at `/tmp/libasound.so.2` using `as`/`ld`. Must set `LD_LIBRARY_PATH=/tmp` when launching Chromium. The driver does this automatically.

- **Use full Chromium, not headless-shell** — `chromium_headless_shell-1223` has the same `libasound` problem but `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` prevents overriding it easily. Use the full binary at `~/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome` via `executablePath`.

- **POS "Open Cash Drawer" modal** — navigating to `[data-section="pos"]` immediately triggers a modal asking you to open a cash drawer. Click `button:has-text("Skip")` to dismiss it before interacting with the POS grid.

- **Login button has no `type="submit"`** — it's `<button class="btn btn-primary login-btn" onclick="App.doLogin()">`. Use `button.login-btn` or `button:has-text("Sign In")`, not `button[type="submit"]`.

- **`text=Point of Sale` matches 3 elements** — "Point of Sale System" appears in the logo. Use `[data-section="pos"]` for navigation, not text selectors.

- **`waitForLoadState('networkidle')` is fine** — the SPA is one large static file (no lazy chunks), so `networkidle` settles quickly after the first load.

## Troubleshooting

- **`error while loading shared libraries: libasound.so.2`**: Run `node .claude/skills/run-pos-system/build-libasound-stub.mjs` first.

- **`object file has no loadable segments`**: The stub was built with Python's struct module (invalid ELF). Rebuild with the `.mjs` builder (uses `as`/`ld`).

- **`Inconsistency detected by ld.so`**: Stub missing version symbols. The `.mjs` builder includes both `ALSA_0.9` and `ALSA_0.9.0rc4` via `.symver` directives — rebuild.

- **`TURSO_DATABASE_URL` error on startup**: Set the env var or leave it unset to use `file:pos.db` locally.

- **Port 3001 already in use**: `pkill -f "node server.js"` then restart.
