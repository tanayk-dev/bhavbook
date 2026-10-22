// S14a-3b: the journal and screenshots through the real app. A screenshot carrying a location and an EXIF block is
// converted in the browser and stored without either; a large one is shrunk under 1 MB. A journal saved on the
// position page is there after a reload.
import { writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { fixture, importFiles, onboardDhan } from './dhan.js';
import { expect, test } from './fixtures.js';
import { png, webpChunks, withExif } from './png.js';

const MAX_BYTES = 1024 * 1024;
const LOCATION = 'GPS 12.9716N 77.5946E';
const EXIF = 'Exif\0\0MARKER-CAMERA-SERIAL';
/** What a canvas writes: the image, alpha, its sRGB colour profile, and the extended header. */
const IMAGE_CHUNKS = new Set(['VP8X', 'ICCP', 'ALPH', 'VP8 ', 'VP8L']);

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

  // A JPEG as a phone writes it: EXIF with an orientation (rotate 90°) and a location; made by the browser itself.
  const jpegBase64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const context = canvas.getContext('2d');
    if (context !== null) {
      context.fillStyle = '#c33';
      context.fillRect(0, 0, 40, 20);
    }
    return canvas.toDataURL('image/jpeg').split(',')[1] ?? '';
  });
  const photo = info.outputPath('photo.jpg');
  writeFileSync(photo, withExif(Buffer.from(jpegBase64, 'base64'), `MARKER-${LOCATION}`));

  await page.getByLabel('Screenshot files').setInputFiles([tagged, large, photo]);
  await expect(page.getByText('Added 3 screenshots.')).toBeVisible();
  const shots = page.getByRole('img', { name: /^Screenshot \d \(opens full size in a new tab\)$/ });
  await expect(shots).toHaveCount(3);
  for (const shot of await shots.all()) {
    const src = await shot.getAttribute('src');
    if (src === null) throw new Error('no src');
    const bytes = await (await page.request.get(new URL(src, page.url()).toString())).body();
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(bytes.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(bytes.length).toBeLessThanOrEqual(MAX_BYTES);
    // Structurally: only picture chunks, never EXIF, XMP or anything else.
    expect(webpChunks(bytes).filter((id) => !IMAGE_CHUNKS.has(id))).toEqual([]);
    const text = bytes.toString('latin1');
    for (const marker of ['GPS 12.97', 'MARKER-']) expect(text).not.toContain(marker);
  }
  // The photo was turned upright (its orientation applied to the pixels), then its EXIF dropped.
  const upright = await shots
    .nth(2)
    .evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]);
  expect(upright).toEqual([20, 40]);
  await page.screenshot({ path: info.outputPath('journal-1280x720.png'), fullPage: true });

  await page.getByRole('button', { name: 'Delete Screenshot 1' }).click();
  await expect(page.getByRole('button', { name: 'Keep' })).toBeFocused();
  await page.getByRole('button', { name: 'Delete it' }).click();
  await expect(shots).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Screenshots' })).toBeFocused();
});
