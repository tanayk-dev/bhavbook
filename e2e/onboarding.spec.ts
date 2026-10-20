// S13a-2: onboarding end to end on a fresh vault: a profile, then a broker account (broker and nickname only),
// then the overview lists it. Nothing on the way asks for a client ID, PAN or login (PRD §4).
import { expect, test } from './fixtures.js';

test('a new vault: profile, broker account, overview', async ({ page, app }, info) => {
  await page.goto(app.launch);
  await expect(page).toHaveURL(`${app.origin}/onboarding`);
  // Wait for the form, then check every text field: only the profile name.
  await expect(page.getByLabel('Profile name')).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(1);
  await expect(page.getByLabel(/client|\bpan\b|password|login|user ?id/i)).toHaveCount(0);

  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByRole('heading', { name: 'Add a broker account' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('onboarding-account-1280x720.png') });
  await expect(page.getByRole('textbox')).toHaveCount(1);

  await page.getByText('Dhan', { exact: true }).click();
  await page.getByLabel('Nickname').fill('D main');
  await page.getByRole('button', { name: 'Add account' }).click();

  await expect(page).toHaveURL(`${app.origin}/`);
  const row = page.getByRole('row', { name: /D main/ });
  await expect(row).toContainText('Dhan');
  await expect(row).toContainText('Swing');
  await page.screenshot({ path: info.outputPath('overview-accounts-1280x720.png') });

  // It persisted: a reload shows the same account.
  await page.reload();
  await expect(page.getByRole('row', { name: /D main/ })).toBeVisible();
});

test('the keyboard alone completes onboarding: focus follows each step', async ({ page, app }) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').focus();
  await page.keyboard.type('Swing');
  await page.keyboard.press('Enter');
  // The account step takes focus on its heading; Tab reaches the broker choice next.
  await expect(page.getByRole('heading', { name: 'Add a broker account' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('radio', { name: 'Zerodha' })).toBeFocused();
  // The broker choice is a radio group: arrow keys move between Zerodha and Dhan.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Dhan' })).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Nickname')).toBeFocused();
  await page.keyboard.type('D main');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('row', { name: /D main/ })).toBeVisible();
});

test('a nickname shaped like a client ID is refused', async ({ page, app }) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.getByLabel('Nickname').fill('ZM1234');
  await page.getByRole('button', { name: 'Add account' }).click();
  await expect(
    page.getByText('That looks like a client ID or PAN. Choose a name of your own.'),
  ).toBeVisible();
  await expect(page.getByLabel('Nickname')).toBeFocused();
});

test('a duplicate profile name is explained, not saved', async ({ page, app }) => {
  await page.goto(app.launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.getByRole('button', { name: 'Create another profile instead' }).click();
  await page.getByLabel('Profile name').fill('swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await expect(page.getByRole('alert')).toHaveText('You already have a profile with this name.');
});
