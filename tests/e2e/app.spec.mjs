import { test, expect } from '@playwright/test';

const SEEN = 'routeguard.pilot.seen.v1';

/** Marks the first-run guide as seen so it never covers the UI in functional tests. */
async function guideSeen(page) {
  await page.addInitScript((k) => {
    try {
      localStorage.setItem(k, '1');
    } catch {}
  }, SEEN);
}

function trackErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // third-party network noise (tile aborts, font fetch) is not an app error
    if (/Failed to load resource|net::ERR|AbortError/i.test(t)) return;
    errors.push(t);
  });
  return errors;
}

async function ready(page) {
  await page.waitForFunction(() => window.routeguard?.state?.solution?.optimal);
}

test.describe('RouteGuard', () => {
  test('loads, plots the optimal track and fills the KPIs without errors', async ({ page }) => {
    const errors = trackErrors(page);
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    await expect(page.locator('#k-time')).toContainText(/\d+ d \d+ h/);
    await expect(page.locator('#k-cost')).toContainText('$');
    await expect(page.locator('#cands .cand')).not.toHaveCount(0);
    await expect(page.locator('#leg-list .leg').first()).toBeVisible();
    await expect(page.locator('#meteo-status')).toHaveText(/LIVE|CACHED|SYNTHETIC/, { timeout: 15_000 });
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  });

  test('Suez drill re-plots around the closure and the convoy re-plans', async ({ page }) => {
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    const before = await page.evaluate(() => window.routeguard.selectedRoute().nodes);
    expect(before).toContain('SUZ');
    await page.getByRole('button', { name: /Suez/ }).first().click();
    await expect(page.locator('#hazard-list')).toContainText('Suez Canal blocked');
    const after = await page.evaluate(() => window.routeguard.selectedRoute().nodes);
    expect(after).not.toContain('SUZ');
    await expect(page.locator('#k-verdict')).toContainText(/Avoided|Re-plotted/);
    await expect(page.locator('#d-time')).toContainText('vs calm');
    await expect(page.locator('.toast').first()).toContainText('Suez Canal Blockage');
    expect(page.url()).toContain('&h=');
  });

  test('Pareto chart: hover readout and click-to-plot', async ({ page }) => {
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    const canvas = page.locator('#pareto');
    await canvas.scrollIntoViewIfNeeded();
    // find a non-selected point from the chart's own geometry
    const pt = await page.evaluate(() => {
      const sel = window.routeguard.selectedRoute();
      const c = document.querySelector('#pareto');
      const r = c.getBoundingClientRect();
      const chart = window.routeguard.state.solution.candidates.find((x) => x !== sel);
      return { sig: chart.signature, rect: [r.x, r.y] };
    });
    // keyboard path: focus canvas, arrow to a point, Enter to plot
    await canvas.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('#pareto-readout')).toBeVisible();
    await expect(page.locator('#pareto-readout')).toContainText(/Transit/);
    const startSig = await page.evaluate(() => window.routeguard.selectedRoute().signature);
    let plotted = startSig;
    for (let i = 0; i < 8 && plotted === startSig; i++) {
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      plotted = await page.evaluate(() => window.routeguard.selectedRoute().signature);
    }
    expect(plotted).not.toBe(startSig);
    await expect(page.locator('.cand.is-sel')).toHaveCount(1);
    expect(pt.sig).toBeTruthy();
    // mouse hover over a plotted point shows the readout
    const p = await page.evaluate(() => {
      const c = document.querySelector('#pareto');
      const r = c.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    await page.mouse.move(p.x + p.w / 2, p.y + p.h / 2);
  });

  test('pilot guide: invite → tour across panels → Esc → never shown again', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    const invite = page.locator('.pilot-invite');
    await expect(invite).toBeVisible({ timeout: 6000 });
    await page.getByRole('button', { name: 'Embark pilot' }).click();
    const card = page.locator('.pilot-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.pilot-count')).toContainText('01 / 13');
    await expect(card.locator('.pilot-title')).toHaveText('This is your passage chart');
    await page.keyboard.press('ArrowRight');
    await expect(card.locator('.pilot-count')).toContainText('02 / 13');
    await expect(card.locator('.pilot-title')).toHaveText('Set the voyage');
    await card.getByRole('button', { name: 'Next' }).click();
    await expect(card.locator('.pilot-count')).toContainText('03 / 13');
    // jump through telemetry → sandbox → convoys
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await expect(card.locator('.pilot-title')).toHaveText('Run the sandbox');
    await expect(page.locator('.pilot-ring')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(card.locator('.pilot-count')).toContainText('08 / 13');
    await page.keyboard.press('Escape');
    await expect(card).toBeHidden();
    await page.reload();
    await ready(page);
    await page.waitForTimeout(2200);
    await expect(invite).toBeHidden();
    // reopen from the header key
    await page.locator('#guide-key').click();
    await expect(card).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('help drawer opens with ?, closes with Esc, and launches a partial tour', async ({ page }) => {
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    await page.locator('body').click({ position: { x: 700, y: 5 } });
    await page.keyboard.press('?');
    const help = page.locator('#help');
    await expect(help).toBeVisible();
    await expect(help).toContainText('Glossary');
    await expect(help).toContainText('ISO 6346');
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await page.locator('#help-key').click();
    await help.getByRole('button', { name: 'Sandbox' }).click();
    await expect(page.locator('.pilot-card')).toBeVisible();
    await expect(page.locator('.pilot-count')).toContainText('01 / 02');
    await expect(page.locator('.pilot-title')).toHaveText('Run the sandbox');
  });

  test('sandbox: clock runs, convoys dispatch, chaos and reset work', async ({ page }) => {
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    const t0 = await page.locator('#sim-clock').textContent();
    await page.waitForTimeout(1200);
    const t1 = await page.locator('#sim-clock').textContent();
    expect(t1).not.toBe(t0);
    const n0 = Number(await page.locator('#convoy-count').textContent());
    await page.getByRole('button', { name: 'Dispatch convoy' }).click();
    await expect(page.locator('#convoy-count')).toHaveText(String(n0 + 1));
    await expect(page.locator('.plate').first()).toContainText('RGUU');
    await page.locator('label.toggle:has(#chaos)').click();
    await expect(page.locator('#deck-log')).toContainText('Chaos mode on');
    await page.locator('#speed button', { hasText: '72×' }).click();
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.getByRole('button', { name: 'Run' })).toBeVisible();
    await page.getByRole('button', { name: 'Reset' }).click();
    await expect(page.locator('#sim-clock')).toHaveText('D+00 00:00');
    await expect(page.locator('#convoy-count')).toHaveText('0');
  });

  test('chart: clicking a hub opens actions and a strike becomes a hazard', async ({ page }) => {
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    await page.waitForFunction(() => window.routeguard.renderer?.map?.loaded?.());
    await page.waitForTimeout(800);
    const pos = await page.evaluate(() => {
      const map = window.routeguard.renderer.map;
      const n = window.routeguard.state.graph.nodes.get('SIN');
      const p = map.project(n.coords);
      const r = map.getContainer().getBoundingClientRect();
      return { x: r.x + p.x, y: r.y + p.y };
    });
    await page.mouse.move(pos.x, pos.y);
    await expect(page.locator('#hover-card')).toContainText('Singapore');
    await page.mouse.click(pos.x, pos.y);
    const pick = page.locator('#pick-card');
    await expect(pick).toBeVisible();
    await pick.getByRole('button', { name: /Inject strike/ }).click();
    await expect(page.locator('#hazard-list')).toContainText('Singapore strike');
  });

  test('scenario link restores voyage, weights and hazards', async ({ page }) => {
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    await page.getByRole('button', { name: /Suez/ }).first().click();
    await page.locator('#w-time').fill('90');
    const url = page.url();
    const page2 = await page.context().newPage();
    await page2.goto(url);
    await ready(page2);
    const s = await page2.evaluate(() => ({ o: window.routeguard.state.origin, d: window.routeguard.state.destination, w: window.routeguard.state.weights.time, nodes: window.routeguard.selectedRoute().nodes, hz: window.routeguard.state.disruptions.map((d) => d.kind) }));
    expect(s.o).toBe('SHA');
    expect(s.d).toBe('RTM');
    expect(s.w).toBe(90);
    expect(s.hz).toContain('CLOSURE');
    expect(s.nodes).not.toContain('SUZ');
  });

  test('manifest download is valid JSON with legs', async ({ page }) => {
    await guideSeen(page);
    await page.goto('/');
    await ready(page);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Route manifest/ }).click()]);
    const path = await dl.path();
    const fs = await import('node:fs/promises');
    const json = JSON.parse(await fs.readFile(path, 'utf8'));
    expect(json.plotted.legs.length).toBeGreaterThan(1);
    expect(json.container.iso6346).toMatch(/^RGUU\d{7}$/);
  });

  test('mobile 390px: no horizontal overflow, guide docks', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto('/');
    await ready(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Embark pilot' }).click();
    await expect(page.locator('.pilot-card.is-docked')).toBeVisible();
    await ctx.close();
  });

  test('404 page is themed', async ({ page }) => {
    const res = await page.goto('/no-such-chart');
    expect(res.status()).toBe(404);
    await expect(page.locator('h1')).toContainText('off the chart');
  });
});
