import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';
import type { RuleModule } from '@typescript-eslint/utils/ts-eslint';
import plugin from '../src/index.mjs';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const ruleTester = new RuleTester({
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
      tsconfigRootDir: fixturesDir,
    },
  },
});

// The plugin is plain JS typed against ESLint's RuleModule; the typescript-eslint tester wants its own variant.
const rule = plugin.rules['no-float-money'] as unknown as RuleModule<'bannedCall' | 'microMustBeBigint'>;

ruleTester.run('no-float-money', rule, {
  valid: [
    'const priceMicro: bigint = 700_600_000n;',
    'const priceMicro = 700_600_000n;',
    'function fee(amountMicro: bigint): bigint { return amountMicro / 100n; }',
    'let maybeMicro: bigint | undefined;',
    'interface Lot { costMicro: bigint; qty: number }',
    'class Fill { valueMicro: bigint = 0n; }',
    'const ok = Number.isInteger(3);',
    'const max = Number.MAX_SAFE_INTEGER;',
    'const total = BigInt("12");',
    'const quantity = 10;',
    'const parts = "a,b".split(",");',
    'const fns = { run: () => 1 }; const key = "run"; fns[key]();',
    'const wrapper = { parseFloat: (s: string) => s }; wrapper.parseFloat("1");',
    'const fee = (feeMicro: bigint = 0n) => feeMicro;',
    'const pick = ({ costMicro }: { costMicro: bigint }) => costMicro;',
    'const fn = function (valueMicro: bigint) { return valueMicro; };',
    'const label = { ["dynamic" + "Micro"]: 1 };',
  ],
  invalid: [
    { code: 'const p = parseFloat("700.60");', errors: [{ messageId: 'bannedCall' }] },
    { code: 'const p = Number.parseFloat("700.60");', errors: [{ messageId: 'bannedCall' }] },
    { code: 'const p = Number("700.60");', errors: [{ messageId: 'bannedCall' }] },
    { code: 'const p = Math.round(700.6);', errors: [{ messageId: 'bannedCall' }] },
    { code: 'const s = (700.6).toFixed(2);', errors: [{ messageId: 'bannedCall' }] },
    { code: 'const priceMicro = 700.6;', errors: [{ messageId: 'microMustBeBigint' }] },
    { code: 'const priceMicro: number = 1;', errors: [{ messageId: 'microMustBeBigint' }] },
    {
      code: 'function fee(totalMicro: number) { return totalMicro; }',
      errors: [{ messageId: 'microMustBeBigint' }],
    },
    { code: 'interface Lot { costMicro: number }', errors: [{ messageId: 'microMustBeBigint' }] },
    { code: 'class Fill { valueMicro = 0; }', errors: [{ messageId: 'microMustBeBigint' }] },
    {
      code: 'let mixedMicro: bigint | number = 0n;',
      errors: [{ messageId: 'microMustBeBigint' }],
    },
  ],
});

// Without type information the rule still bans float calls but cannot (and must not) judge *Micro types.
const untypedTester = new RuleTester();

untypedTester.run('no-float-money (no type information)', rule, {
  valid: ['const priceMicro = 700.6;', 'function fee(totalMicro: number) { return totalMicro; }'],
  invalid: [{ code: 'const p = parseFloat("1");', errors: [{ messageId: 'bannedCall' }] }],
});
