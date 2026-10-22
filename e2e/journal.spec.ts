// S14a-3b: the journal and screenshots through the real app. A screenshot carrying a location and an EXIF block is
// converted in the browser and stored without either; a large one is shrunk under 1 MB. A journal saved on the
// position page is there after a reload.
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { fixture, importFiles, onboardDhan } from './dhan.js';
import { expect, test } from './fixtures.js';
import { png } from './png.js';

const MAX_BYTES = 1024 * 1024;
const LOCATION = 'GPS 12.9716N 77.5946E';
const EXIF = 'Exif\0\0MARKER-CAMERA-SERIAL';

async function openFirstPosition(page: Page, launch: string): Promise<void> {
  await onboardDhan(page, launch);
  await importFiles(page, [fixture('trade_history')]);
  await page.getByRole('link', { name: /^Review/ }).click();
  await page
    .getByRole('table', { name: /Closed positions to review/ })
    .locator('a[data-position]')
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 2, name: 'Journal' })).toBeVisible();
}

test('a journal entry is saved, survives a reload, and the position is reviewed', async ({ page, app }) => {
  await openFirstPosition(page, app.launch);
  await page.getByLabel('Thesis').fill('Bought the breakout, sold into weakness');
  await page.getByLabel('Planned risk (₹)').fill('500');
  await page.getByLabel('Review note').fill('Stop was too tight');
  await page.getByRole('button', { name: 'Save journal' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Thesis')).toHaveValue('Bought the breakout, sold into weakness');
  await expect(page.getByLabel('Planned risk (₹)')).toHaveValue('500');
  await expect(page.getByLabel('Initial stop (₹)')).toHaveAttribute('readonly', '');
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByText(/^Reviewed on /)).toBeVisible();
});

test('screenshots lose their metadata in the browser and stay under 1 MB', async ({ page, app }, info) => {
  await openFirstPosition(page, app.launch);
  const tagged = info.outputPath('tagged.png');
  const large = info.outputPath('large.png');
  writeFileSync(
    tagged,
    png({
      width: 64,
      height: 48,
      metadata: [
        ['tEXt', `Location\0${LOCATION}`],
        ['eXIf', EXIF],
      ],
    }),
  );
  writeFileSync(large, png({ width: 1800, height: 1800, noise: true }));

  await page.getByLabel('Screenshot files').setInputFiles([tagged, large]);
  await expect(page.getByText('Added 2 screenshots.')).toBeVisible();
  const shots = page.getByRole('img', { name: /^Screenshot \d$/ });
  await expect(shots).toHaveCount(2);
  for (const shot of await shots.all()) {
    const src = await shot.getAttribute('src');
    if (src === null) throw new Error('no src');
    const bytes = await (await page.request.get(new URL(src, page.url()).toString())).body();
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(bytes.length).toBeLessThanOrEqual(MAX_BYTES);
    const text = bytes.toString('latin1');
    for (const marker of ['EXIF', 'XMP ', 'GPS 12.97', 'MARKER-CAMERA']) expect(text).not.toContain(marker);
  }
  await page.screenshot({ path: info.outputPath('journal-1280x720.png'), fullPage: true });

  await page.getByRole('button', { name: 'Delete screenshot 1' }).click();
  await page.getByRole('button', { name: 'Delete it' }).click();
  await expect(shots).toHaveCount(1);
});
