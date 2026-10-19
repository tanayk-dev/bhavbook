// End-to-end check against the real exports. They exist only on the author's machine (gitignored),
// so this suite is skipped in CI; CI instead scans the committed fixtures with `pnpm pii:scan`.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { afterAll, describe, expect, it } from 'vitest';
import { buildFixtures } from '../src/make-fixtures.js';
import { scanPaths } from '../src/pii-scan.js';
import { REPO_ROOT, SOURCES } from '../src/sources.js';

const exportsDir = path.join(REPO_ROOT, 'docs', 'broker-exports');
const haveOriginals = SOURCES.every((source) => existsSync(path.join(exportsDir, source.dir)));
const outDir = mkdtempSync(path.join(tmpdir(), 'bhavbook-fixtures-'));

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe.skipIf(!haveOriginals)('buildFixtures on the real exports', { timeout: 60_000 }, () => {
  const results = haveOriginals ? buildFixtures(exportsDir, outDir) : [];

  it('produces a fixture for all 12 report kinds', () => {
    expect(new Set(results.map((result) => `${result.broker}.${result.kind}`)).size).toBe(12);
  });

  it('leaves no personal data in the output (scanner, without the local denylist)', () => {
    expect(scanPaths([outDir], [])).toEqual([]);
  });

  it('keeps CSV fixtures byte-identical apart from replaced metadata and bank values', () => {
    for (const result of results.filter((entry) => entry.format === 'csv')) {
      const before = readFileSync(result.sourcePath).toString('latin1').split('\r\n');
      const after = readFileSync(result.outputPath).toString('latin1').split('\r\n');
      expect(after.length).toBe(before.length);
      const changed = after.filter((line, index) => line !== before[index]);
      expect(changed.length).toBe(result.replaced.length);
    }
  });

  it('keeps every non-scrubbed spreadsheet cell value equal', () => {
    for (const result of results.filter((entry) => entry.format !== 'csv')) {
      const before = XLSX.read(readFileSync(result.sourcePath));
      const after = XLSX.read(readFileSync(result.outputPath));
      expect(after.SheetNames).toEqual(before.SheetNames);
      const scrubbed = new Set(result.replaced);
      for (const name of before.SheetNames) {
        const a = before.Sheets[name] ?? {};
        const b = after.Sheets[name] ?? {};
        for (const ref of Object.keys(a).filter((key) => !key.startsWith('!'))) {
          if (scrubbed.has(`${name}!${ref}`)) continue;
          expect(b[ref]?.v, `${name}!${ref}`).toEqual(a[ref]?.v);
        }
      }
    }
  });

  it('never keeps a client ID in output file names', () => {
    for (const result of results) {
      expect(path.basename(result.outputPath)).not.toMatch(/\d{8,}/);
    }
  });
});
