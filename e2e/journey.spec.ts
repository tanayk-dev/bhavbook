// S16 exit journey, on the anonymised fixtures through the real app: a fresh vault, every fixture of both brokers
// imported, every issue settled, three trades journalled and reviewed, the dashboard read, a backup downloaded and
// restored into another BhavBook with a new, empty vault; that one shows the same dashboard and the same reviews.
import type { Page } from '@playwright/test';
import { addAccount, brokerFixtures } from './dhan.js';
import { expect, startApp, test } from './fixtures.js';

// Each recompute after a fix can take seconds on a slow CI runner.
const SETTLE_MS = 20_000;

const THESES = [
  'Breakout above the range on volume',
  'Pullback to the 20-day average',
  'Result-day gap, sized small',
];

async function importInto(page: Page, account: string, files: string[]): Promise<void> {
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.getByLabel('Import into').selectOption({ label: account });
  await page.getByLabel('Broker files').setInputFiles(files);
  await page.getByRole('button', { name: /^Import \d+ new trade rows?/ }).click();
  await expect(page.getByText(/^Imported \d+ new trade rows?/)).toBeVisible();
}

/** Every open issue settled the way a person would: map, exclude one incomplete position, dismiss the rest. */
async function settleIssues(page: Page): Promise<void> {
  await page.getByRole('link', { name: /Issues/ }).click();
  const open = page.getByRole('article');
  await expect(open.first()).toBeVisible();
  const settle = async (action: () => Promise<void>): Promise<void> => {
    const before = await open.count();
    await action();
    await expect.poll(() => open.count(), { timeout: SETTLE_MS }).toBeLessThan(before);
  };

  const unknown = page.getByRole('article', { name: /Unknown instrument/ });
  while ((await unknown.count()) > 0) {
    const card = unknown.first();
    await card.getByRole('radio', { name: /It has no ISIN/ }).check();
    await settle(() => card.getByRole('button', { name: 'Use this instrument' }).click());
  }
  const incomplete = page.getByRole('article', { name: /Incomplete position/ }).first();
  await incomplete.getByRole('button', { name: 'Exclude…' }).click();
  await settle(() => incomplete.getByRole('button', { name: 'Exclude position' }).click());
  while ((await open.count()) > 0) {
    await settle(() => open.first().getByRole('button', { name: 'Dismiss' }).click());
  }
  await expect(page.getByText('Nothing needs your attention')).toBeVisible();
}

async function journalThree(page: Page): Promise<void> {
  for (const thesis of THESES) {
    await page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Review/ })
      .click();
    await page
      .getByRole('table', { name: /Closed positions to review/ })
      .locator('a[data-position]')
      .first()
      .click();
    await page.getByLabel('Thesis').fill(thesis);
    await page.getByRole('button', { name: 'Save journal' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Mark reviewed' }).click();
    await expect(page.getByText(/^Reviewed on /)).toBeVisible();
  }
}

interface ReadBack {
  readonly dashboard: string[];
  readonly reviewed: string[];
  readonly theses: string[];
}

/** What the dashboard says (the metrics strip and the monthly table), the reviewed rows and their journals. */
async function readBack(page: Page, origin: string): Promise<ReadBack> {
  await page.goto(`${origin}/`);
  const metrics = page.getByRole('region', { name: 'Metrics' });
  // Loaded and not empty: trades were won and lost.
  await expect(metrics).toContainText(/[1-9][\d,]* won, [1-9][\d,]* lost/);
  const monthly = page.getByRole('region', { name: 'Net P&L by month' });
  await monthly.getByText('Show as a table').click();
  const months = monthly.getByRole('table', { name: 'Realised P&L by month' });
  await expect(months.getByRole('row').nth(1)).toBeVisible();
  const dashboard = [await metrics.innerText(), await months.innerText()];

  await page.goto(`${origin}/review?tab=reviewed`);
  const reviewed = page.getByRole('row').filter({ has: page.locator('a[data-position]') });
  await expect(reviewed).toHaveCount(THESES.length);
  const rows = (await reviewed.allInnerTexts()).sort();
  const links = await page
    .locator('a[data-position]')
    .evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
  const theses: string[] = [];
  for (const link of links) {
    await page.goto(`${origin}${link}`);
    await expect(page.getByLabel('Thesis')).not.toHaveValue('');
    theses.push(await page.getByLabel('Thesis').inputValue());
  }
  return { dashboard, reviewed: rows, theses: theses.sort() };
}

test('a fresh vault to the dashboard, then backed up and restored into another with the same numbers', async ({
  page,
  app,
  browser,
}, info) => {
  // About fifty issues are settled one by one; slow CI runners need several minutes.
  test.setTimeout(300_000);
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await addAccount(page, 'Dhan', 'D main');
  await page.getByRole('link', { name: 'Add a broker account' }).click();
  await addAccount(page, 'Zerodha', 'Kite');

  await importInto(page, 'D main (Dhan, Swing)', brokerFixtures('dhan'));
  await importInto(page, 'Kite (Zerodha, Swing)', brokerFixtures('zerodha'));
  await settleIssues(page);
  await journalThree(page);
  const before = await readBack(page, app.origin);
  expect(before.theses).toEqual([...THESES].sort());
  await page.screenshot({ path: info.outputPath('journey-reviewed-1280x720.png'), fullPage: true });

  await page.goto(`${app.origin}/settings`);
  await page.getByRole('button', { name: 'Back up now' }).click();
  // A consistent copy of the whole vault, checksummed: slow runners need more than the default 5 s.
  await expect(page.getByText(/^Backed up BhavBook/)).toBeVisible({ timeout: SETTLE_MS });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page
      .getByRole('region', { name: 'Backup list' })
      .getByRole('link', { name: /^Download the backup from/ })
      .first()
      .click(),
  ]);
  const backup = info.outputPath('journey.bhav');
  await download.saveAs(backup);

  const other = await startApp();
  // A context of its own: both apps are on 127.0.0.1, and each one's session cookie is named after its port.
  const context = await browser.newContext().catch(async (error: unknown) => {
    await other.close();
    throw error;
  });
  try {
    const fresh = await context.newPage();
    await fresh.goto(other.launch);
    // A new vault starts at onboarding: nothing of the first one is there.
    await expect(fresh.getByLabel('Profile name')).toBeVisible();
    await fresh.goto(`${other.origin}/settings`);
    await fresh.getByLabel('Restore from a file').setInputFiles(backup);
    await fresh
      .getByRole('group', { name: 'Confirm restore' })
      .getByRole('button', { name: 'Restore' })
      .click();
    await expect(fresh.getByText(/^Restored /)).toBeVisible({ timeout: 20_000 });

    expect(await readBack(fresh, other.origin)).toEqual(before);
    await fresh.goto(`${other.origin}/`);
    await expect(fresh.getByRole('img', { name: /Net P&L by month/ }).locator('svg')).toBeVisible();
    await fresh.screenshot({
      path: info.outputPath('journey-restored-dashboard-1280x720.png'),
      fullPage: true,
    });
    await fresh.goto(`${other.origin}/issues`);
    await expect(fresh.getByText('Nothing needs your attention')).toBeVisible();
  } finally {
    await context.close();
    await other.close();
  }
});
