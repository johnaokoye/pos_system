// Produces the "Completing a Basic Sale" training video for the POS manual:
// records real Playwright interaction against the live app, narrates each
// step with offline TTS, and muxes video + narration + subtitles into one
// MP4 + sidecar VTT, paced so narration and on-screen action stay in sync.
import { chromium } from '@playwright/test';
import { synthesize } from './tts.mjs';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORK_DIR = '/tmp/pos-video-build';
const OUT_DIR = path.join(__dirname, '..', '..', '..', '..', 'public', 'training-videos');
const VIDEO_ID = 'pos-basic-sale';
const TITLE = 'Point of Sale: Completing a Basic Sale';

fs.rmSync(WORK_DIR, { recursive: true, force: true });
fs.mkdirSync(WORK_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const TRAILING_PAUSE_MS = 700; // silence after narration finishes, before next step
const LEAD_IN_MS = 300; // brief pause before acting, so narration starts first

async function closeVisibleModal(page) {
  const closeBtn = page.locator('.modal-close:visible').first();
  if (await closeBtn.count()) {
    await closeBtn.click({ timeout: 3000 }).catch(() => {});
  }
}

// Each step: narration text spoken while (after a brief lead-in) `action` runs.
// Steps are paced to the narration's real synthesized duration, so audio and
// video timelines are derived from the same schedule instead of guessed.
const steps = [
  {
    id: 'intro',
    narration: "Welcome to the Point of Sale training video. In this lesson, we'll walk through completing a basic retail sale from start to finish.",
    action: async () => {},
  },
  {
    id: 'open-sales-hub',
    narration: 'From the sidebar, click Sales to open the Sales hub.',
    action: async (page) => {
      await page.click('[data-section="sales-hub"]');
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'open-pos',
    narration: 'Then click Point of Sale to open the register screen.',
    action: async (page) => {
      await page.getByText('Point of Sale', { exact: true }).click();
      await page.waitForTimeout(600);
    },
  },
  {
    id: 'drawer-note',
    narration: "If a cash drawer isn't already open for this session, you'd be prompted to open one here, so the app can track cash for reconciliation later. We already have a drawer open, so we'll go straight to the register.",
    action: async (page) => {
      const skip = page.locator('button:has-text("Skip"):visible').first();
      if (await skip.count()) await skip.click().catch(() => {});
    },
  },
  {
    id: 'item-lookup',
    narration: 'To ring up a sale, click Item Lookup to browse or search the catalog.',
    action: async (page) => {
      await page.click('button:has-text("ITEM LOOKUP")');
      await page.waitForTimeout(500);
    },
  },
  {
    id: 'add-item',
    narration: "Click a product to add it to the ticket. Here we're adding a bag of Coffee Beans.",
    action: async (page) => {
      await page.getByText('Coffee Beans 1lb', { exact: true }).click();
      await page.waitForTimeout(500);
    },
  },
  {
    id: 'close-lookup',
    narration: 'Close the lookup window, and the item appears on the ticket with its price and a running subtotal.',
    action: async (page) => {
      await closeVisibleModal(page);
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'payment',
    narration: 'When the sale is ready, click Payment to choose how the customer is paying.',
    action: async (page) => {
      await page.click('button:has-text("PAYMENT")');
      await page.waitForTimeout(500);
    },
  },
  {
    id: 'cash',
    narration: 'Select Cash for an immediate cash sale.',
    action: async (page) => {
      await page.click('button:has-text("Exact / Change")');
      await page.waitForTimeout(500);
    },
  },
  {
    id: 'amount',
    narration: "Enter the amount the customer handed over. Here it's the exact total.",
    action: async (page) => {
      await page.fill('#ctm-tendered', '12.99');
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'confirm',
    narration: 'Click Confirm Payment to complete the sale.',
    action: async (page) => {
      await page.click('button:has-text("Confirm Payment")');
      await page.waitForTimeout(1000);
    },
  },
  {
    id: 'outro',
    narration: "That's it. The sale is complete and a receipt is ready to print. You've just completed a basic sale in Point of Sale.",
    action: async () => {},
  },
];

function msToVttTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = Math.floor(ms % 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(msRem).padStart(3, '0')}`;
}

async function main() {
  console.log('== Step 1/5: synthesizing narration ==');
  for (const [i, step] of steps.entries()) {
    step.wavPath = path.join(WORK_DIR, `step-${i}.wav`);
    step.durationSec = await synthesize(step.narration, step.wavPath);
    console.log(`  [${step.id}] ${step.durationSec.toFixed(2)}s — "${step.narration.slice(0, 50)}..."`);
  }

  console.log('== Step 2/5: recording browser session ==');
  const browser = await chromium.launch({
    executablePath: `${process.env.HOME}/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome`,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp' },
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: WORK_DIR, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();

  await page.goto('http://localhost:3001');
  await page.fill('#login-user', 'admin');
  await page.fill('#login-pass', '123456');
  await page.click('button.login-btn');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000); // settle on dashboard before recording narration begins

  const recordingStart = Date.now();
  for (const step of steps) {
    step.startMs = Date.now() - recordingStart;
    await page.waitForTimeout(LEAD_IN_MS);
    await step.action(page).catch((e) => console.warn(`  [warn] action for ${step.id} failed:`, e.message));
    const elapsed = Date.now() - recordingStart - step.startMs;
    const targetMs = step.durationSec * 1000 + TRAILING_PAUSE_MS;
    if (elapsed < targetMs) await page.waitForTimeout(targetMs - elapsed);
    step.endMs = Date.now() - recordingStart;
    console.log(`  [${step.id}] ${step.startMs}ms -> ${step.endMs}ms`);
  }

  const videoHandle = page.video();
  await context.close();
  await browser.close();
  const rawVideoPath = await videoHandle.path();
  console.log('  recorded:', rawVideoPath);

  console.log('== Step 3/5: mixing narration track ==');
  const mixedAudioPath = path.join(WORK_DIR, 'narration-mixed.wav');
  const inputs = [];
  const filterParts = [];
  steps.forEach((step, i) => {
    inputs.push('-i', step.wavPath);
    filterParts.push(`[${i}:a]adelay=${Math.round(step.startMs)}|${Math.round(step.startMs)}[a${i}]`);
  });
  const mixInputs = steps.map((_, i) => `[a${i}]`).join('');
  const filterComplex = `${filterParts.join(';')};${mixInputs}amix=inputs=${steps.length}:duration=longest:normalize=0[aout]`;
  await execFileAsync(ffmpegPath, [
    '-y', ...inputs,
    '-filter_complex', filterComplex,
    '-map', '[aout]',
    mixedAudioPath,
  ]);
  console.log('  mixed audio:', mixedAudioPath);

  console.log('== Step 4/5: muxing final video ==');
  const finalMp4 = path.join(OUT_DIR, `${VIDEO_ID}.mp4`);
  await execFileAsync(ffmpegPath, [
    '-y',
    '-i', rawVideoPath,
    '-i', mixedAudioPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest',
    finalMp4,
  ]);
  console.log('  final video:', finalMp4);

  console.log('== Step 5/5: writing subtitles ==');
  let vtt = 'WEBVTT\n\n';
  for (const step of steps) {
    vtt += `${msToVttTime(step.startMs)} --> ${msToVttTime(step.endMs)}\n${step.narration}\n\n`;
  }
  const vttPath = path.join(OUT_DIR, `${VIDEO_ID}.vtt`);
  fs.writeFileSync(vttPath, vtt);
  console.log('  subtitles:', vttPath);

  console.log('\nDone. Output:', finalMp4, vttPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
