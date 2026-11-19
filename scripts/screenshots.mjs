/**
 * Captures README screenshots with Playwright: node scripts/screenshots.mjs
 * Starts the static server itself on :4175 and writes docs/screenshots/*.png.
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

const PORT = 4175;
const BASE = `http://localhost:${PORT}`;
const OUT = 'docs/screenshots';
await mkdir(OUT, { recursive: true });

const server = spawn(process.execPath, ['scripts/serve.mjs', String(PORT)], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 800));

const browser = await chromium.launch();
const seen = (ctx) => ctx.addInitScript(() => localStorage.setItem('routeguard.pilot.seen.v1', '1'));
const ready = (page) => page.waitForFunction(() => window.routeguard?.state?.solution?.optimal && window.routeguard.renderer?.map?.loaded?.(), null, { timeout: 30000 });
const settle = (page, ms = 2500) => page.waitForTimeout(ms);

async function shot(name, { viewport = { width: 1600, height: 960 }, palette = 'night', setup, guide = false, fullPage = false } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: palette === 'day' ? 'light' : 'dark' });
  await ctx.addInitScript((p) => localStorage.setItem('routeguard.palette', p), palette);
  if (!guide) await seen(ctx);
  const page = await ctx.newPage();
  await page.goto(BASE);
  await ready(page);
  await settle(page, 1500);
  if (setup) await setup(page);
  await settle(page);
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage });
  console.log('✓', name);
  await ctx.close();
}

try {
  await shot('01-night-suez', {
    setup: async (p) => {
      await p.getByRole('button', { name: /Suez/ }).first().click();
      await p.waitForTimeout(5000);
    },
  });
  await shot('02-dusk-cyclone', {
    palette: 'dusk',
    setup: async (p) => {
      await p.getByRole('button', { name: /Cyclone/ }).first().click();
      await p.locator('#cands').scrollIntoViewIfNeeded();
    },
  });
  await shot('03-day-mombasa', {
    palette: 'day',
    setup: async (p) => {
      await p.getByRole('button', { name: /Mombasa/ }).first().click();
      await p.waitForTimeout(3000);
    },
  });
  await shot('04-pilot-guide', {
    guide: true,
    setup: async (p) => {
      await p.getByRole('button', { name: 'Embark pilot' }).click();
      for (let i = 0; i < 4; i++) {
        await p.keyboard.press('ArrowRight');
        await p.waitForTimeout(350);
      }
      await p.waitForTimeout(800);
    },
  });
  await shot('05-help-drawer', {
    setup: async (p) => {
      await p.locator('#help-key').click();
    },
  });
  await shot('06-chaos-sandbox', {
    setup: async (p) => {
      await p.locator('#speed button', { hasText: '24×' }).click();
      await p.locator('label.toggle:has(#chaos)').click();
      await p.locator('label.toggle:has(#auto-dispatch)').click();
      await p.waitForTimeout(9000);
      await p.locator('#convoys').scrollIntoViewIfNeeded();
    },
  });
  await shot('10-fig2-decision-regions', {
    setup: async (p) => {
      await p.getByRole('button', { name: /Suez/ }).first().click();
      await p.waitForTimeout(2500);
      await p.locator('#simplex-block').scrollIntoViewIfNeeded();
      await p.waitForTimeout(1500);
      const box = await p.locator('#simplex').boundingBox();
      await p.mouse.move(box.x + box.width * 0.42, box.y + box.height * 0.62);
    },
  });
  await shot('11-follow-convoy', {
    palette: 'dusk',
    setup: async (p) => {
      await p.locator('#speed button', { hasText: '24×' }).click();
      await p.getByRole('button', { name: 'Dispatch convoy' }).click();
      await p.waitForTimeout(2500);
      await p.locator('#convoys').scrollIntoViewIfNeeded();
      await p.locator('.convoy').first().click();
      await p.waitForTimeout(3500);
    },
  });
  await shot('07-mobile-night', { viewport: { width: 390, height: 844 } });
  await shot('08-mobile-day-telemetry', {
    viewport: { width: 390, height: 844 },
    palette: 'day',
    setup: async (p) => {
      await p.locator('#kpis').scrollIntoViewIfNeeded();
    },
  });
  await shot('09-guide-mobile', {
    viewport: { width: 390, height: 844 },
    guide: true,
    setup: async (p) => {
      await p.getByRole('button', { name: 'Embark pilot' }).click();
      await p.keyboard.press('ArrowRight');
      await p.waitForTimeout(800);
    },
  });
} finally {
  await browser.close();
  server.kill();
}
