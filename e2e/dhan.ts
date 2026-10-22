// Shared steps for E2E tests: onboarding an account (Dhan for the anonymised fixtures) and importing files.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'packages',
  'adapters',
  'fixtures',
);

/** The fixture file of a Dhan report kind (`trade_history`, `tax_report`, ...). */
export function fixture(kind: string): string {
  const dir = path.join(FIXTURES, 'dhan', kind);
  const [file] = readdirSync(dir);
  if (file === undefined) throw new Error(`no ${kind} fixture`);
  return path.join(dir, file);
}

/** The trade file without the 17 Sep 2024 IPO allotment, as the PRD describes the export (plan E11). */
export function tradesWithoutAllotment(outputPath: string): string {
  writeFileSync(
    outputPath,
    readFileSync(fixture('trade_history'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.startsWith('2024-09-17,09:22:16,Bajaj Housing Finance'))
      .join('\r\n'),
  );
  return outputPath;
}

/** A first run: one profile with one account of the broker. */
export async function onboard(
  page: Page,
  launch: string,
  broker: 'Dhan' | 'Zerodha',
  nickname: string,
): Promise<void> {
  await page.goto(launch);
  await page.getByLabel('Profile name').fill('Swing');
  await page.getByRole('button', { name: 'Create profile' }).click();
  await page.locator('label', { hasText: broker }).click();
  await page.getByLabel('Nickname').fill(nickname);
  await page.getByRole('button', { name: 'Add account' }).click();
}

export async function onboardDhan(page: Page, launch: string): Promise<void> {
  await onboard(page, launch, 'Dhan', 'D main');
}

export async function importFiles(page: Page, files: string[]): Promise<void> {
  await page.getByRole('link', { name: 'Import', exact: true }).click();
  await page.getByLabel('Broker files').setInputFiles(files);
  await page.getByRole('button', { name: /^Import \d+ new trade rows?/ }).click();
  await expect(page.getByText(/^Imported \d+ new trade rows?/)).toBeVisible();
}
