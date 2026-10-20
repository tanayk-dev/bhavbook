// App settings (PRD §9.2, §8): the breakeven threshold, and the fee-rule versions behind the stored charges.
// Settings live in the `setting` key-value table; money is micro-rupees, sent as decimal strings.
import { bundledFeeRules, parseDecimalToMicro } from '@bhavbook/core';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ProfileError } from './profiles.js';

const BREAKEVEN_KEY = 'breakeven_threshold_micro';
/** Up to ₹10,00,000, at most paise: a breakeven band, not a target. */
export const breakevenSchema = z
  .object({ breakevenThresholdRupees: z.string().regex(/^\d{1,7}(\.\d{1,2})?$/) })
  .strict();
const MAX_BREAKEVEN_MICRO = 1_000_000n * 1_000_000n;

export interface FeeRuleVersion {
  readonly id: string;
  readonly kind: 'statutory' | 'broker';
  readonly effectiveFrom: string;
  /** Charges stored with this version (0: bundled but not used by any trade yet). */
  readonly charges: number;
}

export interface Settings {
  readonly breakevenThresholdMicro: string;
  readonly feeRules: readonly FeeRuleVersion[];
}

/** The stored threshold; a missing or unreadable value is the default, ₹0. */
export function breakevenThresholdMicro(db: Database.Database): bigint {
  const value: unknown = db.prepare('SELECT value FROM setting WHERE key = ?').pluck().get(BREAKEVEN_KEY);
  return typeof value === 'string' && /^\d{1,13}$/.test(value) ? BigInt(value) : 0n;
}

interface UsageRow {
  readonly rule_version: string;
  readonly n: bigint;
}

function feeRuleVersions(db: Database.Database): FeeRuleVersion[] {
  const used = new Map<string, number>();
  const rows = db
    .prepare(
      'SELECT rule_version, count(*) AS n FROM fill_charge WHERE rule_version IS NOT NULL GROUP BY rule_version',
    )
    .all() as UsageRow[];
  for (const row of rows) {
    // A charge records `<statutory id>+<broker id>`: each part is a version in use.
    for (const id of row.rule_version.split('+')) used.set(id, (used.get(id) ?? 0) + Number(row.n));
  }
  const rules = bundledFeeRules();
  return [
    ...rules.statutory.map((rule) => ({
      id: rule.id,
      kind: 'statutory' as const,
      effectiveFrom: rule.effectiveFrom,
    })),
    ...rules.broker.map((rule) => ({
      id: rule.id,
      kind: 'broker' as const,
      effectiveFrom: rule.effectiveFrom,
    })),
  ].map((rule) => ({ ...rule, charges: used.get(rule.id) ?? 0 }));
}

export function readSettings(db: Database.Database): Settings {
  return { breakevenThresholdMicro: breakevenThresholdMicro(db).toString(), feeRules: feeRuleVersions(db) };
}

/** Sets the breakeven threshold from rupees ("0.50"). */
export function setBreakeven(db: Database.Database, input: unknown): void {
  const parsed = breakevenSchema.safeParse(input);
  if (!parsed.success) throw new ProfileError('invalid');
  const micro = parseDecimalToMicro(parsed.data.breakevenThresholdRupees);
  if (micro > MAX_BREAKEVEN_MICRO) throw new ProfileError('invalid');
  db.prepare(
    'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(BREAKEVEN_KEY, micro.toString());
}
