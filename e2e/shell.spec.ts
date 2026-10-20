// S13a-1: the web shell end to end. The launch token never stays in the URL (ADR-0002), nothing is fetched from
// anywhere but the local server (PRD §12), deep links work, and a browser without the session gets nothing.
import { expect, test } from './fixtures.js';

const VIEWPORTS = [
  { name: '1440x900', width: 1440, height: 900 },
  { name: '1280x800', width: 1280, height: 800 },
  { name: '1024x768', width: 1024, height: 768 },
  { name: '390x844', width: 390, height: 844 },
] as const;

test('the launch URL opens the app with the token gone from the address bar', async ({ page, app }) => {
  const hosts = new Set<string>();
  page.on('request', (request) => hosts.add(new URL(request.url()).host));
  await page.goto(app.launch);
  await expect(page.getByText(/Vault schema v\d+/)).toBeVisible();
  expect(page.url()).toBe(`${app.origin}/`);
  expect(page.url()).not.toContain('t=');
  expect(await page.evaluate(() => window.location.search)).toBe('');
  expect([...hosts]).toEqual([new URL(app.origin).host]);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'No trades yet' })).toBeVisible();
});

test('a deep link works once the session cookie is set', async ({ page, app }) => {
  await page.goto(app.launch);
  await page.goto(`${app.origin}/nowhere`);
  await expect(page.getByText('There is no page at this address.')).toBeVisible();
});

test('without the session nothing is served: no app, no API', async ({ browser, app }) => {
  const stranger = await browser.newContext();
  const page = await stranger.newPage();
  const response = await page.goto(`${app.origin}/`);
  expect(response?.status()).toBe(401);
  expect(await page.content()).not.toContain('id="root"');
  const api = await stranger.request.get(`${app.origin}/api/vault`);
  expect(api.status()).toBe(401);
  await stranger.close();
});

test('a wrong launch token is refused', async ({ page, app }) => {
  const response = await page.goto(`${app.origin}/?t=wrong`);
  expect(response?.status()).toBe(401);
});

for (const theme of ['light', 'dark'] as const) {
  test(`renders at every target viewport (${theme})`, async ({ page, app }, info) => {
    await page.goto(app.launch);
    if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await expect(page.getByText(/Vault schema v\d+/)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect([viewport.name, overflow]).toEqual([viewport.name, false]);
      await page.screenshot({
        path: info.outputPath(`overview-${theme}-${viewport.name}.png`),
        fullPage: true,
      });
    }
  });
}

test('the keyboard reaches every control, each with a visible focus indicator', async ({ page, app }) => {
  await page.goto(app.launch);
  await expect(page.getByText(/Vault schema v\d+/)).toBeVisible();
  const reached: string[] = [];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press('Tab');
    reached.push(
      await page.evaluate(() => {
        const active = document.activeElement;
        if (active === null) return 'nothing';
        const style = getComputedStyle(active);
        // An outline (links) or a ring drawn as a box shadow (shadcn buttons) both count.
        const visible = style.outlineStyle !== 'none' || style.boxShadow !== 'none';
        return `${active.getAttribute('aria-label') ?? active.textContent}|${visible ? 'visible' : 'hidden'}`;
      }),
    );
  }
  expect(reached).toEqual(['BhavBook|visible', 'Switch to dark theme|visible', 'Overview|visible']);
});
