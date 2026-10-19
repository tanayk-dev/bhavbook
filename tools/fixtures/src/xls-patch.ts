// Scrubs spreadsheets. Legacy .xls is patched in place (see binary-patch.ts); .xlsx is rewritten only when needed.
// Either way the output is re-read and re-checked, so a missed or partial replacement fails loudly.
import * as XLSX from 'xlsx';
import { patchBinary } from './binary-patch.js';
import { PERSONAL_PROPERTIES, scanContainer, scanText, scanWorkbook } from './pii-scan.js';
import { scrubWorkbook, type CellChange } from './scrub.js';

export interface SpreadsheetScrubResult {
  readonly output: Buffer;
  readonly changes: readonly string[];
}

/** Personal document properties, plus any custom property whose value trips a detector or denylist term. */
function personalProperties(workbook: XLSX.WorkBook, denyTerms: readonly string[]): [string, string][] {
  const props = (workbook.Props ?? {}) as Record<string, unknown>;
  const standard = PERSONAL_PROPERTIES.flatMap((key): [string, string][] => {
    const value = props[key];
    return typeof value === 'string' && value.trim() !== '' && !/^X+$/.test(value.trim()) ? [[key, value]] : [];
  });
  const custom = Object.entries((workbook.Custprops ?? {}) as Record<string, unknown>).flatMap(
    ([key, value]): [string, string][] =>
      typeof value === 'string' && scanText(value, 'custom', denyTerms).length > 0 ? [[`custom:${key}`, value]] : [],
  );
  return [...standard, ...custom];
}

function verify(output: Buffer, denyTerms: readonly string[]): void {
  const reread = XLSX.read(output);
  const leftover = scrubWorkbook(reread, denyTerms);
  const findings = [...scanWorkbook(reread, 'output', denyTerms), ...scanContainer(output, 'output', denyTerms)];
  if (leftover.length > 0 || findings.length > 0) {
    const kinds = [...new Set([...leftover.map((change) => change.reason), ...findings.map((finding) => finding.kind)])];
    throw new Error(`scrubbed spreadsheet still contains personal data (${kinds.join(', ')}); fix the source by hand`);
  }
}

function patchXls(input: Buffer, changes: readonly CellChange[], props: readonly [string, string][]): Buffer {
  const replacements = new Map<string, string>();
  for (const change of changes) replacements.set(change.from, change.to);
  for (const [, value] of props) replacements.set(value, 'X'.repeat(value.length));
  if (replacements.size === 0) return input;
  // Longest first, so a short value can never rewrite part of a longer one.
  const ordered = [...replacements]
    .sort(([a], [b]) => b.length - a.length)
    .map(([from, to]) => ({ from, to }));
  return patchBinary(input, ordered).bytes;
}

function rewriteXlsx(input: Buffer, workbook: XLSX.WorkBook, changes: readonly CellChange[], props: readonly [string, string][]): Buffer {
  if (changes.length === 0 && props.length === 0) return input;
  const target = (workbook.Props ?? {}) as Record<string, unknown>;
  const custom = (workbook.Custprops ?? {}) as Record<string, unknown>;
  for (const [key, value] of props) {
    if (key.startsWith('custom:')) custom[key.slice('custom:'.length)] = 'X'.repeat(value.length);
    else target[key] = 'X'.repeat(value.length);
  }
  workbook.Custprops = custom;
  workbook.Props = target as XLSX.FullProperties;
  const written: unknown = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  if (!Buffer.isBuffer(written)) throw new Error('SheetJS did not return a Buffer');
  return written;
}

export function scrubSpreadsheet(input: Buffer, format: 'xls' | 'xlsx', denyTerms: readonly string[]): SpreadsheetScrubResult {
  const workbook = XLSX.read(input, { cellNF: true, cellStyles: true });
  const props = personalProperties(workbook, denyTerms);
  const changes = scrubWorkbook(workbook, denyTerms);
  const output = format === 'xls' ? patchXls(input, changes, props) : rewriteXlsx(input, workbook, changes, props);
  verify(output, denyTerms);
  return { output, changes: [...changes.map((change) => change.cell), ...props.map(([key]) => `#${key}`)] };
}
