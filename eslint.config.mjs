// Flat config. Guardrails: no float money in core/adapters (ADR-0004) and a purity boundary (plan invariant 6).
import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import bhavbook from 'eslint-plugin-bhavbook';

const MONEY_PACKAGES = ['packages/core/**/*.ts', 'packages/adapters/**/*.ts'];

const IO_MODULES = [
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'http',
  'node:http',
  'https',
  'node:https',
  'http2',
  'node:http2',
  'dgram',
  'node:dgram',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'better-sqlite3',
  '@bhavbook/server',
];

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'docs/**',
      'plans/**',
      '**/fixtures/**',
      'tools/eslint-plugin-bhavbook/test/fixtures/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['**/*.test.ts', 'tools/**/*.ts', '**/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: MONEY_PACKAGES,
    plugins: { bhavbook },
    rules: {
      'bhavbook/no-float-money': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: IO_MODULES.map((name) => ({
            name,
            message: 'core and adapters are pure: do I/O in packages/server (plan invariant 6).',
          })),
        },
      ],
    },
  },
  prettier,
);
