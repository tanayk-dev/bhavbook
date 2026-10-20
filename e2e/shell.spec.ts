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
  const cspViolations: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') hosts.add(url.host);
  });
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) cspViolations.push(message.text());
  });
  await page.goto(app.launch);
  await expect(page.getByRole('heading', { name: 'Set up BhavBook' })).toBeVisible();
  // A new vault starts at onboarding; the address bar never shows the token.
  expect(page.url()).toBe(`${app.origin}/onboarding`);
  expect(page.url()).not.toContain('t=');
  expect(await page.evaluate(() => window.location.search)).toBe('');
  expect([...hosts]).toEqual([new URL(app.origin).host]);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  expect(cspViolations).toEqual([]);
});

test('a dark theme choice is applied before the app renders after a reload', async ({ page, app }) => {
  await page.goto(app.launch);
  await page.getByRole('button', { name: 'Switch to dark theme' }).click();
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(true);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
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
      await expect(page.getByRole('heading', { name: 'Set up BhavBook' })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
      expect([viewport.name, overflow]).toEqual([viewport.name, false]);
      await page.screenshot({
        path: info.outputPath(`onboarding-${theme}-${viewport.name}.png`),
        fullPage: true,
      });
    }
  });
}

/** The focused control's name, and whether it shows a 2 px accent outline or ring (after any transition). */
function focusIndicator(): string {
  const active = document.activeElement;
  if (active === null) return 'nothing';
  const style = getComputedStyle(active);
  const accent = 'rgb(31, 90, 138)';
  // Links show the global outline; shadcn buttons draw the same accent as a 2 px ring (box shadow).
  const outline =
    style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2 && style.outlineColor === accent;
  const ring = style.boxShadow.includes(`${accent} 0px 0px 0px 2px`);
  return `${active.getAttribute('aria-label') ?? active.textContent}|${outline || ring ? 'visible' : 'faint'}`;
}

test('the keyboard reaches every control, each with a 2 px accent focus indicator', async ({ page, app }) => {
  await page.goto(app.launch);
  await expect(page.getByRole('heading', { name: 'Set up BhavBook' })).toBeVisible();
  for (const name of ['Skip to content', 'BhavBook', 'Switch to dark theme', 'Overview']) {
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(focusIndicator)).toBe(`${name}|visible`);
  }
});
