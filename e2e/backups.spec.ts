// S13a-3b-2: backups through the real server. Back up, change something, restore the backup (the running server
// closes, swaps and reopens its vault), download a backup, and refuse a file that is not one.
import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures.js';

test('back up, change, restore, download; a bad file changes nothing', async ({ page, app }, info) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.goto(`${app.origin}/settings`);

  await page.getByRole('button', { name: 'Back up now' }).click();
  await expect(page.getByText(/^Backed up BhavBook \(\d+ KB\)\.$/)).toBeVisible();
  const list = page.getByRole('region', { name: 'Backup list' });
  await expect(list.getByRole('row', { name: /Made by you/ })).toHaveCount(1);

  await page.getByLabel('New setup tag').fill('Breakout');
  await page.getByRole('button', { name: 'Add setup tag' }).click();
  await expect(page.getByRole('region', { name: 'Setup tags' })).toContainText('Breakout');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    list.getByRole('link', { name: /^Download the backup from/ }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^bhavbook-backup-\d{8}T\d{9}Z-manual\.bhav$/);
  const saved = info.outputPath('downloaded.bhav');
  await download.saveAs(saved);
  expect(readFileSync(saved).subarray(0, 4).toString('latin1')).toBe('BHAV');

  await list.getByRole('button', { name: /^Restore the backup from/ }).click();
  await page.screenshot({ path: info.outputPath('settings-restore-confirm-1280x720.png'), fullPage: true });
  await page.getByRole('group', { name: 'Confirm restore' }).getByRole('button', { name: 'Restore' }).click();
  await expect(page.getByText(/^Restored the backup from .+ IST\.$/)).toBeVisible();
  await expect(page.getByText('No setup tags yet.')).toBeVisible();
  await expect(list.getByRole('row', { name: /Before a restore/ })).toHaveCount(1);

  await page.getByLabel('Restore from a file').setInputFiles({
    name: 'notes.bhav',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('not a backup'),
  });
  await page.getByRole('group', { name: 'Confirm restore' }).getByRole('button', { name: 'Restore' }).click();
  await expect(
    page.getByText('That file is not a BhavBook backup. Your current data is unchanged.'),
  ).toBeVisible();

  // The server kept working on the restored vault, and it persisted.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Rename Swing' })).toBeVisible();
  await expect(page.getByText('No setup tags yet.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('settings-backups-1280x720.png'), fullPage: true });
});
