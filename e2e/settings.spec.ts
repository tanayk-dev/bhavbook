// S13a-3a/3b: onboarding, then settings: rename, move an account to another profile (confirm, then recompute), the
// breakeven threshold, and tags. Trades can't be imported through the UI until S13b, so the recompute observed here
// rebuilds zero positions; the server tests cover a recompute of real fixture trades.
import { expect, test } from './fixtures.js';

test('onboarding, then settings: rename, move an account (recomputed), breakeven', async ({
  page,
  app,
}, info) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.getByLabel('Nickname').fill('D main');
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.getByRole('link', { name: 'Add a broker account' }).click();
  await page.getByRole('button', { name: 'Create another profile instead' }).click();
  await page.getByLabel('Profile name').fill('Long-term');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByRole('heading', { name: 'Add a broker account' })).toBeVisible();

  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page).toHaveURL(`${app.origin}/settings`);
  expect(page.url()).not.toContain('t=');

  await page.getByRole('button', { name: 'Rename D main' }).click();
  await page.getByLabel('New nickname').fill('Dhan main');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Rename Dhan main' })).toBeVisible();

  await page.getByRole('button', { name: 'Move…' }).click();
  const confirm = page.getByRole('group', { name: 'Confirm moving Dhan main' });
  await expect(confirm).toContainText('Move Dhan main to Long-term? Its positions are recomputed.');
  await page.screenshot({ path: info.outputPath('settings-move-confirm-1280x720.png'), fullPage: true });
  await confirm.getByRole('button', { name: 'Move and recompute' }).click();
  await expect(page.getByText('Moved Dhan main to Long-term and recomputed 0 positions.')).toBeVisible();
  await expect(page.getByRole('row', { name: /Dhan main/ })).toContainText('Long-term');

  await page.getByLabel('New threshold (₹)').fill('10');
  await page.getByRole('button', { name: 'Save threshold' }).click();
  await expect(page.getByText('Breakeven threshold saved: ₹10.')).toBeVisible();
  await expect(page.getByRole('row', { name: /nse\/2024-10-01/ })).toContainText('01 Oct 2024');
  await page.screenshot({ path: info.outputPath('settings-1280x720.png'), fullPage: true });

  // All of it persisted.
  await page.reload();
  await expect(page.getByRole('row', { name: /Dhan main/ })).toContainText('Long-term');
  await expect(page.getByText('₹10.00').first()).toBeVisible();
});

test('at phone width the settings page never scrolls sideways, even with a form open', async ({
  page,
  app,
}) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.getByLabel('Nickname').fill('A long account nickname');
  await page.getByRole('button', { name: 'Add account' }).click();
  await page.goto(`${app.origin}/settings`);
  await page.setViewportSize({ width: 390, height: 844 });
  const overflows = () => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  expect(await overflows()).toBe(false);
  await page.getByRole('button', { name: 'Rename A long account nickname' }).click();
  expect(await overflows()).toBe(false);
});

test('tags: add setup and mistake tags, rename, merge, delete', async ({ page, app }, info) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.goto(`${app.origin}/settings`);

  for (const name of ['Breakout', 'BO', 'Pullback']) {
    await page.getByLabel('New setup tag').fill(name);
    await page.getByRole('button', { name: 'Add setup tag' }).click();
    await expect(page.getByText(`Added the setup tag ${name}.`)).toBeVisible();
  }
  await page.getByLabel('New mistake tag').fill('FOMO');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Mistake tags' })).toContainText('FOMO');

  await page.getByLabel('New setup tag').fill('breakout');
  await page.keyboard.press('Enter');
  await expect(page.getByText('You already have a tag of this kind with this name.')).toBeVisible();

  await page.getByRole('button', { name: 'Rename Pullback' }).click();
  await page.getByLabel('New setup tag name').fill('Pullback to EMA');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Renamed the tag to Pullback to EMA.')).toBeVisible();

  await page.getByLabel('Merge BO into').selectOption({ label: 'Breakout' });
  await page.getByRole('button', { name: 'Merge BO…' }).click();
  await page
    .getByRole('group', { name: 'Confirm merging BO' })
    .getByRole('button', { name: 'Merge' })
    .click();
  await expect(page.getByText('Merged BO into Breakout on 0 journal entries.')).toBeVisible();

  await page.getByRole('button', { name: 'Delete FOMO…' }).click();
  await page
    .getByRole('group', { name: 'Confirm deleting FOMO' })
    .getByRole('button', { name: 'Delete tag' })
    .click();
  await expect(page.getByText('No mistake tags yet.')).toBeVisible();
  await page.screenshot({ path: info.outputPath('settings-tags-1280x720.png'), fullPage: true });

  await page.reload();
  const setups = page.getByRole('region', { name: 'Setup tags' });
  await expect(setups.getByRole('row')).toHaveCount(3);
  await expect(setups).toContainText('Pullback to EMA');
  await expect(setups).not.toContainText(/\bBO\b/);
});
