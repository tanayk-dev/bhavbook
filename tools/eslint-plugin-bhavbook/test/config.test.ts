// Lints virtual files through the real repo ESLint config, proving the guardrails apply where intended.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const eslint = new ESLint({ cwd: repoRoot });

async function ruleIdsFor(code: string, relativePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(repoRoot, relativePath) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
}

// The first lint builds the TypeScript program for the repo, which takes several seconds on a cold start.
describe('repo ESLint config', { timeout: 30_000 }, () => {
  it('rejects parseFloat inside packages/core', async () => {
    const ids = await ruleIdsFor('export const p = parseFloat("1.5");\n', 'packages/core/src/index.ts');
    expect(ids).toContain('bhavbook/no-float-money');
  });

  it('rejects parseFloat inside packages/adapters', async () => {
    const ids = await ruleIdsFor('export const p = parseFloat("1.5");\n', 'packages/adapters/src/index.ts');
    expect(ids).toContain('bhavbook/no-float-money');
  });

  it('allows parseFloat outside the money packages', async () => {
    const ids = await ruleIdsFor('export const p = parseFloat("1.5");\n', 'packages/web/src/index.ts');
    expect(ids).not.toContain('bhavbook/no-float-money');
  });

  it.each([
    'node:fs',
    'fs',
    'node:net',
    'node:http',
    'node:child_process',
    'node:worker_threads',
    'better-sqlite3',
    '@bhavbook/server',
  ])('rejects importing %s inside packages/core (purity boundary)', async (specifier) => {
    const ids = await ruleIdsFor(
      `import * as m from '${specifier}';\nexport { m };\n`,
      'packages/core/src/index.ts',
    );
    expect(ids).toContain('no-restricted-imports');
  });

  it('rejects importing node:fs inside packages/adapters', async () => {
    const ids = await ruleIdsFor(
      `import * as m from 'node:fs';\nexport { m };\n`,
      'packages/adapters/src/index.ts',
    );
    expect(ids).toContain('no-restricted-imports');
  });

  it('allows node:fs inside packages/server', async () => {
    const ids = await ruleIdsFor(
      `import * as m from 'node:fs';\nexport { m };\n`,
      'packages/server/src/index.ts',
    );
    expect(ids).not.toContain('no-restricted-imports');
  });
});
