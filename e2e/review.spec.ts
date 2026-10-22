// S14a-3a: the review queue and the position detail through the real app on the anonymised Dhan trade file. The
// plan's check "reviewing 10 positions with the keyboard only takes under 2 minutes" runs here, keyboard only.
import { fixture, importFiles, onboardDhan } from './dhan.js';
import { expect, test } from './fixtures.js';

const TEN = 10;
const TWO_MINUTES_MS = 2 * 60 * 1000;

test('ten positions are reviewed with the keyboard alone; the counter follows', async ({
  page,
  app,
}, info) => {
  await onboardDhan(page, app.launch);
  await importFiles(page, [fixture('trade_history')]);
  await page.getByRole('link', { name: /^Review/ }).click();
  const rows = page.getByRole('table', { name: /Closed positions to review/ }).locator('a[data-position]');
  await expect(rows.first()).toBeVisible();
  const before = await rows.count();
  expect(before).toBeGreaterThan(TEN);
  const counter = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Review/ });
  await expect(counter).toHaveAccessibleName(`Review, ${String(before)} to review`);
  await page.screenshot({ path: info.outputPath('review-1280x720.png') });

  const started = Date.now();
  await rows.first().focus();
  for (let reviewed = 0; reviewed < TEN; reviewed += 1) {
    await page.keyboard.press('r');
    // The next position takes the focus; the list shrinks by one each time.
    await expect(rows).toHaveCount(before - reviewed - 1);
    await expect(rows.first()).toBeFocused();
  }
  expect(Date.now() - started).toBeLessThan(TWO_MINUTES_MS);
  await expect(counter).toHaveAccessibleName(`Review, ${String(before - TEN)} to review`);

  await page.getByRole('button', { name: 'Reviewed', exact: true }).click();
  await expect(
    page.getByRole('table', { name: 'Reviewed positions' }).locator('a[data-position]'),
  ).toHaveCount(TEN);
});

test('a position opens from the queue with its lots, fills and charges', async ({ page, app }, info) => {
  await onboardDhan(page, app.launch);
  await importFiles(page, [fixture('trade_history')]);
  await page.getByRole('link', { name: /^Review/ }).click();
  const first = page
    .getByRole('table', { name: /Closed positions to review/ })
    .locator('a[data-position]')
    .first();
  const name = await first.innerText();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(page.getByRole('table', { name: /Lots/ }).getByRole('row')).not.toHaveCount(1);
  const fills = page.getByRole('table', { name: /Fills/ });
  await expect(fills.getByRole('row').nth(1)).toContainText(/Buy|Sell/);
  await expect(page.getByRole('table', { name: /Charges/ }).getByRole('row', { name: /STT/ })).toBeVisible();
  await page.screenshot({ path: info.outputPath('position-1280x720.png'), fullPage: true });
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByText(/^Reviewed on /)).toBeVisible();
  await page.getByRole('button', { name: 'Reopen review' }).click();
  await expect(page.getByText('Not reviewed yet.')).toBeVisible();
});
