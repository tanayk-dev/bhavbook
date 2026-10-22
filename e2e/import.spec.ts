// S13b-2: the import wizard through the real server with the real (anonymised) fixtures. Import every Dhan and
// Zerodha fixture into its account, see the history and coverage, re-import (everything is a duplicate), and undo.
import path from 'node:path';
import { addAccount, brokerFixtures as fixtures } from './dhan.js';
import { expect, test } from './fixtures.js';

test('import every fixture, re-import as duplicates, undo', async ({ page, app }, info) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await addAccount(page, 'Dhan', 'D main');
  await page.getByRole('link', { name: 'Add a broker account' }).click();
  await addAccount(page, 'Zerodha', 'Kite');

  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Import', exact: true })).toBeVisible();

  const dhan = fixtures('dhan');
  await page.getByLabel('Import into').selectOption({ label: 'D main (Dhan, Swing)' });
  await page.getByLabel('Broker files').setInputFiles(dhan);
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.getByRole('row')).toHaveCount(dhan.length + 1);
  await expect(preview.getByRole('row', { name: /TRADE_HISTORY/ })).toContainText('Dhan trade history');
  await expect(preview.getByRole('row', { name: /Ledger/ })).toContainText('not imported in v1');
  await page.screenshot({ path: info.outputPath('import-preview-1280x720.png'), fullPage: true });
  const importButton = page.getByRole('button', { name: 'Import 116 new trade rows and 170 statement rows' });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(
    page.getByText(
      'Imported 116 new trade rows and 170 statement rows into D main. Positions were recomputed.',
    ),
  ).toBeVisible();

  const history = page.getByRole('region', { name: 'Imports' });
  // Four Dhan reports are not imported in v1 (fund summary, ledger, P&L, realised P&L); the preview says why.
  const imported = dhan.length - 4;
  await expect(history.getByRole('row').filter({ hasText: 'Dhan' })).toHaveCount(imported);
  await expect(page.getByRole('heading', { name: 'Dhan trade history' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-history-coverage-1280x720.png'), fullPage: true });

  // Again: nothing new.
  await page.getByLabel('Broker files').setInputFiles(dhan);
  await expect(
    page.getByText('Nothing new to import: these rows are already imported or skipped.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import 0 new trade rows/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Start over' }).click();

  await history.getByRole('button', { name: /^Undo the Dhan trade history import/ }).click();
  await page
    .getByRole('group', { name: /Confirm undoing the import/ })
    .getByRole('button', { name: 'Undo import' })
    .click();
  await expect(
    page.getByText(/^Undid the Dhan trade history import from .+; 116 trade rows removed\.$/),
  ).toBeVisible();
  await expect(history.getByRole('row').filter({ hasText: 'Dhan' })).toHaveCount(imported - 1);

  // Zerodha: every fixture, plus a Dhan file that is explained, not imported; then the same loop.
  await page.getByLabel('Import into').selectOption({ label: 'Kite (Zerodha, Swing)' });
  const zerodha = fixtures('zerodha');
  const dhanTrades = dhan.filter((file) => file.includes(`${path.sep}trade_history${path.sep}`));
  await page.getByLabel('Broker files').setInputFiles([...zerodha, ...dhanTrades]);
  await expect(preview.getByRole('row')).toHaveCount(zerodha.length + 2);
  await expect(preview.getByRole('row', { name: /tradebook/ })).toContainText('Zerodha tradebook');
  await expect(preview.getByRole('row', { name: /TRADE_HISTORY/ })).toContainText(
    'A Dhan file, but this is a Zerodha account.',
  );
  await page.getByRole('button', { name: /^Import \d+ new trade rows/ }).click();
  await expect(page.getByText(/into Kite\./)).toBeVisible();
  const zerodhaImports = history.getByRole('row').filter({ hasText: 'Zerodha' });
  await expect(zerodhaImports.filter({ hasText: 'Zerodha tradebook' })).toHaveCount(1);
  const kept = await zerodhaImports.count();

  await page.getByLabel('Broker files').setInputFiles(zerodha);
  await expect(
    page.getByText('Nothing new to import: these rows are already imported or skipped.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start over' }).click();
  await history.getByRole('button', { name: /^Undo the Zerodha tradebook import/ }).click();
  await page
    .getByRole('group', { name: /Confirm undoing the import/ })
    .getByRole('button', { name: 'Undo import' })
    .click();
  await expect(page.getByText(/^Undid the Zerodha tradebook import from /)).toBeVisible();
  await expect(zerodhaImports).toHaveCount(kept - 1);
});
