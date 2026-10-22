// S14b-2 (plan): the Tata Motors demerger example through the real app. A holding bought before the October 2025
// ex-date is demerged 1:1 with 31.15% of the cost to the child (PRD §7.4's example; the trades are made up): the
// preview shows the lots before and after, saving splits the position in two, and reverting puts it back.
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { importFiles, onboard } from './dhan.js';
import { expect, test } from './fixtures.js';

const PARENT = 'INE155A01022';
const CHILD = 'INE1TAE01010';
const TRADEBOOK = [
  'symbol,isin,trade_date,exchange,segment,series,trade_type,auction,quantity,price,trade_id,order_id,order_execution_time',
  `TATAMOTORS,${PARENT},2025-09-01,NSE,EQ,EQ,buy,false,10,700,9001,8001,2025-09-01T10:00:00`,
].join('\r\n');

async function openPositions(
  page: Page,
): Promise<{ instrumentKey: string; openQty: string; boughtValueMicro: string }[]> {
  const response = await page.request.get(new URL('/api/positions?state=OPEN', page.url()).toString());
  return (
    (await response.json()) as {
      positions: { instrumentKey: string; openQty: string; boughtValueMicro: string }[];
    }
  ).positions;
}

test('the Tata demerger: preview, save, the position splits, revert', async ({ page, app }, info) => {
  const file = info.outputPath('tradebook.csv');
  writeFileSync(file, TRADEBOOK);
  await onboard(page, app.launch, 'Zerodha', 'Z main');
  await importFiles(page, [file]);
  await page.getByRole('link', { name: 'Corporate actions' }).click();

  await page.getByRole('radio', { name: 'Demerger' }).check();
  await page.getByLabel('Parent ISIN').fill(PARENT);
  await page.getByLabel('Child ISIN').fill(CHILD);
  await page.getByLabel('Ex-date').fill('2025-10-14');
  await page.getByLabel('Child shares', { exact: true }).fill('1');
  await page.getByLabel('Parent shares', { exact: true }).fill('1');
  await page.getByLabel("Child's share of the cost (%)").fill('31.15');
  await page.getByRole('button', { name: 'Preview' }).click();

  const before = page.getByRole('table', { name: 'Open lots before the action' });
  await expect(before.getByRole('row')).toHaveCount(2);
  await expect(before).toContainText('₹7,000.00');
  const after = page.getByRole('table', { name: 'Open lots after the action' });
  await expect(after.getByRole('row')).toHaveCount(3);
  await expect(after).toContainText('₹4,819.50');
  await expect(after).toContainText('₹2,180.50');
  await page.screenshot({ path: info.outputPath('corporate-actions-1280x720.png'), fullPage: true });
  expect(await openPositions(page)).toHaveLength(1);

  await page.getByRole('button', { name: 'Save this action' }).click();
  await expect(page.getByText('Saved the corporate action; every account was rebuilt.')).toBeVisible();
  const entered = page.getByRole('table', { name: /Corporate actions entered/ });
  await expect(entered.getByRole('row', { name: /Demerger/ })).toContainText(
    '31.15% of the cost to the child',
  );
  const split = await openPositions(page);
  expect(
    split.map((position) => [position.instrumentKey, position.openQty, position.boughtValueMicro]).sort(),
  ).toEqual(
    [
      [PARENT, '10', '4819500000'],
      [CHILD, '10', '2180500000'],
    ].sort(),
  );

  await entered.getByRole('button', { name: 'Revert' }).click();
  await expect(page.getByText('Reverted; every account was rebuilt without it.')).toBeVisible();
  await expect(entered.getByRole('row', { name: /Demerger/ })).toContainText('Reverted');
  expect(await openPositions(page)).toEqual([
    expect.objectContaining({ instrumentKey: PARENT, openQty: '10' }),
  ]);
});
