// S15b-2 exit criterion: the dashboard's numbers for the fixture vault equal S15a's golden values. On the anonymised
// Dhan fixtures, FY 2024-25 realised gross is Dhan's own P&L report (−₹4,893.82) minus the three paise its reports
// disagree with its trade file by (S9, S15a): −₹4,893.85. The charts are drawn (SVG) with a table of the same numbers.
import type { Page } from '@playwright/test';
import { fixture, importFiles, onboardDhan } from './dhan.js';
import { expect, test } from './fixtures.js';

/**
 * ₹ amounts as Money shows them ("▲ +₹1,234.56", "▼ −₹7.00", "₹250.00") in paise. A cell's text starts with the
 * words a screen reader hears ("loss ₹7.00", unsigned), so the visible, signed amount is the last one.
 */
function paise(text: string): bigint {
  const match = [...text.matchAll(/([+−-]?)₹([\d,]+)\.(\d{2})/g)].at(-1);
  if (match === undefined) throw new Error(`no amount in "${text}"`);
  const value = BigInt(`${(match[2] ?? '0').replace(/,/g, '')}${match[3] ?? '00'}`);
  return match[1] === '−' || match[1] === '-' ? -value : value;
}

async function openDashboard(page: Page, search: string): Promise<void> {
  await page.goto(new URL(`/${search}`, page.url()).toString());
  await expect(page.getByRole('region', { name: 'Metrics' })).toBeVisible();
}

test('FY 2024-25 realised gross on the dashboard equals the golden value', async ({ page, app }, info) => {
  await onboardDhan(page, app.launch);
  await importFiles(page, [
    fixture('trade_history'),
    fixture('global_transactions'),
    fixture('dp_charges'),
    fixture('tax_report'),
  ]);
  await openDashboard(page, '?from=2024-04-01&to=2025-03-31&includeIncomplete=true');

  // The charts are drawn, each a labelled SVG image.
  for (const name of [/Equity curve/, /Net P&L by month/, /Calendar of realised net/]) {
    await expect(page.getByRole('img', { name }).locator('svg')).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('dashboard-1280x720.png'), fullPage: true });

  const monthly = page.getByRole('region', { name: 'Net P&L by month' });
  await monthly.getByText('Show as a table').click();
  const rows = monthly.getByRole('table', { name: 'Realised P&L by month' }).getByRole('row');
  const count = await rows.count();
  expect(count).toBeGreaterThan(2);
  let gross = 0n;
  for (let index = 1; index < count; index += 1) {
    gross += paise((await rows.nth(index).getByRole('cell').first().textContent()) ?? '');
  }
  expect(gross).toBe(-489_385n);

  // The filters live in the URL: a reload keeps them.
  await page.reload();
  await expect(page.getByLabel('From')).toHaveValue('2024-04-01');
  await expect(page.getByLabel('Include incomplete positions')).toBeChecked();
});
