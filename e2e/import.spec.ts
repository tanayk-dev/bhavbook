// S13b-2: the import wizard through the real server with the real (anonymised) fixtures. Import every Dhan and
// Zerodha fixture into its account, see the history and coverage, re-import (everything is a duplicate), and undo.
import { readdirSync } from 'node:fs';
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

/** Every fixture file of a broker, one per report kind. */
function fixtures(broker: string): string[] {
  const dir = path.join(FIXTURES, broker);
  return readdirSync(dir).flatMap((kind) =>
    readdirSync(path.join(dir, kind)).map((file) => path.join(dir, kind, file)),
  );
}

async function addAccount(page: Page, broker: 'Zerodha' | 'Dhan', nickname: string): Promise<void> {
  await page.locator('label', { hasText: broker }).click();
  await expect(page.getByRole('radio', { name: broker })).toBeChecked();
  await page.getByLabel('Nickname').fill(nickname);
  await page.getByRole('button', { name: 'Add account' }).click();
}

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
  const importButton = page.getByRole('button', { name: /^Import \d+ new trade rows/ });
  await expect(importButton).toBeEnabled();
  await importButton.click();
  await expect(
    page.getByText(/^Imported \d+ new trade rows? and \d+ statement rows? into D main\./),
  ).toBeVisible();

  const history = page.getByRole('region', { name: 'Imports' });
  // Four Dhan reports are not imported in v1 (fund summary, ledger, P&L, realised P&L); the preview says why.
  const imported = dhan.length - 4;
  await expect(history.getByRole('row').filter({ hasText: 'Dhan' })).toHaveCount(imported);
  await expect(page.getByRole('heading', { name: 'Dhan trade history' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-history-coverage-1280x720.png'), fullPage: true });

  // Again: nothing new.
  await page.getByLabel('Broker files').setInputFiles(dhan);
  await expect(page.getByText('Everything in these files is already imported.')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Import 0 new trade rows/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Start over' }).click();

  await history.getByRole('button', { name: /^Undo the Dhan trade history import/ }).click();
  await page
    .getByRole('group', { name: /Confirm undoing the import/ })
    .getByRole('button', { name: 'Undo import' })
    .click();
  await expect(
    page.getByText(/^Undid the Dhan trade history import from .+; \d+ trade rows? removed\.$/),
  ).toBeVisible();
  await expect(history.getByRole('row').filter({ hasText: 'Dhan' })).toHaveCount(imported - 1);

  // Zerodha: its tradebook imports into the Zerodha account; a Dhan file there is explained, not imported.
  await page.getByLabel('Import into').selectOption({ label: 'Kite (Zerodha, Swing)' });
  const zerodha = fixtures('zerodha');
  const tradebook = zerodha.filter((file) => file.includes(`${path.sep}tradebook${path.sep}`));
  const dhanTrades = dhan.filter((file) => file.includes(`${path.sep}trade_history${path.sep}`));
  await page.getByLabel('Broker files').setInputFiles([...tradebook, ...dhanTrades]);
  await expect(preview.getByRole('row', { name: /tradebook/ })).toContainText('Zerodha tradebook');
  await expect(preview.getByRole('row', { name: /TRADE_HISTORY/ })).toContainText(
    'A Dhan file, but this is a Zerodha account.',
  );
  await page.getByRole('button', { name: /^Import \d+ new trade rows/ }).click();
  await expect(page.getByText(/into Kite\./)).toBeVisible();
  await expect(history.getByRole('row').filter({ hasText: 'Zerodha tradebook' })).toHaveCount(1);
});
