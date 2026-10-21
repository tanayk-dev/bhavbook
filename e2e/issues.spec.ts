// S13c-2: the issues inbox through the real server and the real (anonymised) Dhan fixtures. Each fix is checked by
// what it changes: the issue leaves the open list (and the badge), and dependent issues resolve with it.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures.js';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'adapters',
  'fixtures',
);

function fixture(kind: string): string {
  const dir = path.join(FIXTURES, 'dhan', kind);
  const [file] = readdirSync(dir);
  if (file === undefined) throw new Error(`no ${kind} fixture`);
  return path.join(dir, file);
}

async function onboardDhan(page: Page, launch: string): Promise<void> {
  await page.goto(launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.locator('label', { hasText: 'Dhan' }).click();
  await page.getByLabel('Nickname').fill('D main');
  await page.getByRole('button', { name: 'Add account' }).click();
}

async function importFiles(page: Page, files: string[]): Promise<void> {
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.getByLabel('Broker files').setInputFiles(files);
  await page.getByRole('button', { name: /^Import \d+ new trade rows?/ }).click();
  await expect(page.getByText(/^Imported \d+ new trade rows?/)).toBeVisible();
}

/** The trade file without the 17 Sep 2024 IPO allotment, as the PRD describes the export (plan E11). */
function tradesWithoutAllotment(outputPath: string): string {
  writeFileSync(
    outputPath,
    readFileSync(fixture('trade_history'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('2024-09-17,09:22:16,Bajaj Housing Finance'))
      .join('\r\n'),
  );
  return outputPath;
}

const openCount = (page: Page) =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Issues/ });

test('an unknown scrip is mapped and leaves the inbox', async ({ page, app }) => {
  await onboardDhan(page, app.launch);
  await importFiles(page, [fixture('trade_history')]);
  await page.getByRole('link', { name: /Issues/ }).click();
  const unknown = page.getByRole('article', { name: /Unknown instrument/ });
  await expect(unknown.first()).toBeVisible();
  const before = await unknown.count();
  expect(before).toBeGreaterThan(0);
  const first = unknown.first();
  const heading = await first.getByRole('heading').innerText();
  await first.getByRole('radio', { name: /It has no ISIN/ }).check();
  await first.getByRole('button', { name: 'Use this instrument' }).click();
  await expect(page.getByText(/^Mapped “.+”; positions were recomputed\.$/)).toBeVisible();
  await expect(unknown).toHaveCount(before - 1);
  await expect(page.getByRole('heading', { name: heading, exact: true })).toHaveCount(0);
});

test('the statement lot completes the IPO position; a fee difference is read and dismissed', async ({
  page,
  app,
}, info) => {
  const trades = tradesWithoutAllotment(info.outputPath('trades-without-allotment.csv'));
  await onboardDhan(page, app.launch);
  await importFiles(page, [
    trades,
    fixture('global_transactions'),
    fixture('dp_charges'),
    fixture('tax_report'),
  ]);
  await page.getByRole('link', { name: /Issues/ }).click();

  const fill = page.getByRole('article', { name: /Fill from broker statement/ });
  await expect(fill).toContainText('200 shares');
  await expect(page.getByRole('article', { name: /Incomplete position: Bajaj Housing/ })).toHaveCount(1);
  const badge = await openCount(page).innerText();
  await page.screenshot({ path: info.outputPath('issues-1280x720.png'), fullPage: true });

  await fill.getByRole('button', { name: 'Use this lot' }).click();
  await expect(page.getByText('Used the statement lot; the position was recomputed.')).toBeVisible();
  await expect(fill).toHaveCount(0);
  // The position it completes is no longer incomplete.
  await expect(page.getByRole('article', { name: /Incomplete position: Bajaj Housing/ })).toHaveCount(0);
  await expect(openCount(page)).not.toHaveText(badge);

  const fees = page.getByRole('article', { name: /Charges differ from the statement/ }).first();
  await expect(fees.getByRole('region', { name: 'Charge differences' })).toBeVisible();
  const feeCount = await page.getByRole('article', { name: /Charges differ/ }).count();
  await fees.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByText('Dismissed the issue.')).toBeVisible();
  await expect(page.getByRole('article', { name: /Charges differ/ })).toHaveCount(feeCount - 1);
  await page.getByLabel('Show').selectOption('dismissed');
  await expect(page.getByRole('article', { name: /Charges differ/ })).toHaveCount(1);
});

test('an opening lot completes the position by hand', async ({ page, app }, info) => {
  await onboardDhan(page, app.launch);
  await importFiles(page, [tradesWithoutAllotment(info.outputPath('trades.csv'))]);
  await page.getByRole('link', { name: /Issues/ }).click();
  const incomplete = page.getByRole('article', { name: /Incomplete position: Bajaj Housing/ });
  await incomplete.getByRole('button', { name: 'Add opening lot…' }).click();
  await incomplete.getByLabel('Total cost (₹)').fill('35,200');
  await incomplete.getByLabel('Bought on').fill('2024-09-17');
  await incomplete.getByRole('button', { name: 'Add opening lot', exact: true }).click();
  await expect(page.getByText('Added the opening lot; the position was recomputed.')).toBeVisible();
  await expect(incomplete).toHaveCount(0);
  await page.getByLabel('Show').selectOption('resolved');
  await expect(incomplete).toContainText('Resolved: nothing to do.');
});

test('excluding a position resolves it; the kind filter and j/k find their way', async ({
  page,
  app,
}, info) => {
  await onboardDhan(page, app.launch);
  await importFiles(page, [tradesWithoutAllotment(info.outputPath('trades.csv'))]);
  await page.getByRole('link', { name: /Issues/ }).click();
  await page.getByLabel('Kind').selectOption('incomplete_position');
  const cards = page.getByRole('article');
  await expect(cards).toHaveCount(1);
  await cards.first().getByRole('button', { name: 'Exclude…' }).focus();
  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { name: /Incomplete position: Bajaj Housing/ })).toBeFocused();
  await cards.first().getByRole('button', { name: 'Exclude…' }).click();
  await cards.first().getByRole('button', { name: 'Exclude position' }).click();
  await expect(page.getByText(/^Excluded the position from every metric/)).toBeVisible();
  await expect(page.getByText('Nothing needs your attention')).toBeVisible();
});
