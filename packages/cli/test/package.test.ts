import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from '../src/index.js';

interface Manifest {
  readonly name: string;
  readonly bin?: Record<string, string>;
  readonly files?: readonly string[];
  readonly engines?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly publishConfig?: Record<string, unknown>;
  readonly scripts?: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Manifest;

describe('bhavbook package wiring', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('bhavbook');
    expect(manifest.name).toBe('bhavbook');
  });

  it('runs as `npx bhavbook` from the bundle, and ships only the bundle', () => {
    expect(manifest.bin).toEqual({ bhavbook: './dist/index.mjs' });
    expect(manifest.files).toEqual(['dist']);
    expect(manifest.engines).toEqual({ node: '>=24.11' });
    expect(manifest.publishConfig).toMatchObject({ access: 'public', exports: { '.': './dist/index.mjs' } });
    expect(manifest.scripts?.prepack).toBeDefined();
  });

  it('installs only what cannot be bundled: the native SQLite binding and the browser opener', () => {
    // The workspace packages, hono, zod, csv-parse and SheetJS are bundled; a `workspace:` range would not install.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['better-sqlite3', 'open']);
    expect(Object.values(manifest.dependencies ?? {}).every((range) => /^\d+\.\d+\.\d+$/.test(range))).toBe(
      true,
    );
    expect(manifest.devDependencies?.['@bhavbook/server']).toBe('workspace:*');
  });
});
