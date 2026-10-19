// Replaces personal data in broker exports while keeping everything else intact (plan step S2).
// CSVs are edited as bytes (latin1 round-trips every byte), so quoting, CRLF and missing trailing newlines survive.
import * as XLSX from 'xlsx';
import {
  DEMAT_PATTERN,
  fitPlaceholder,
  isPlaceholderValue,
  PLACEHOLDERS,
  redactDematNumber,
  type PlaceholderKey,
} from './placeholders.js';

export interface CsvScrubOptions {
  /** Data columns to overwrite in every row, e.g. `{ Bank: PLACEHOLDERS.bank }`. Missing columns are an error. */
  readonly replaceColumns?: Readonly<Record<string, string>>;
  /** The file has a metadata block (Dhan Journal CSVs); finding no metadata label is an error. */
  readonly expectMetadata?: boolean;
}

export interface CsvScrubResult {
  readonly bytes: Buffer;
  /** Labels and column names that were replaced (each once). */
  readonly replaced: readonly string[];
  /** Number of lines whose bytes changed. */
  readonly changedLines: number;
}

const UTF8_BOM_LATIN1 = 'ï»¿';

/**
 * Labels that introduce personal data, matched after normalising (lower case, trailing `:`/`.` removed).
 * Broad on purpose; table headers such as "Security Name" or "Bank Name" don't match.
 */
const LABEL_RULES: readonly (readonly [RegExp, PlaceholderKey])[] = [
  [/^(?:(?:client|customer|investor|account holder|holder|applicant|first|last|full)\s+)?name(?:\s+of\s+(?:the\s+)?(?:client|holder|investor))?$|^(?:account holder|investor)$/, 'name'],
  [/^(?:ucc|ucc code|unique client code)$/, 'ucc'],
  [/^(?:client|customer|user)\s*(?:id|code|no|number)$/, 'clientId'],
  [/^pan(?:\s*(?:no|number|card))?$/, 'pan'],
  [/^(?:mobile|phone|contact)(?:\s*(?:no|number))?$/, 'mobile'],
  [/^e-?mail(?:\s*(?:id|address))?$/, 'email'],
];

/** The placeholder kind a label introduces, if any. */
export function labelKey(text: string): PlaceholderKey | undefined {
  const label = text.replace(UTF8_BOM_LATIN1, '').replace(/[:.\s]+$/, '').trim().toLowerCase();
  return LABEL_RULES.find(([pattern]) => pattern.test(label))?.[1];
}

/** Splits a CSV line on commas outside double quotes (Dhan fields never contain newlines). */
function splitCsvFields(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

function unquote(field: string): string {
  return field.startsWith('"') && field.endsWith('"') && field.length >= 2 ? field.slice(1, -1) : field;
}

function replaceField(field: string, value: string): string {
  return field.startsWith('"') && field.endsWith('"') ? `"${value}"` : value;
}

/** `label,value[,…]` → the value field replaced; quoting and every other field are kept (values may contain commas). */
function scrubMetadataLine(line: string): { line: string; label?: string; found: boolean } {
  const fields = splitCsvFields(line);
  const [labelField = '', valueField] = fields;
  const key = labelKey(unquote(labelField.replace(UTF8_BOM_LATIN1, '')));
  if (key === undefined || valueField === undefined) return { line, found: false };
  const value = unquote(valueField);
  if (value.trim() === '' || isPlaceholderValue(key, value)) return { line, found: true };
  const next = [labelField, replaceField(valueField, PLACEHOLDERS[key]), ...fields.slice(2)].join(',');
  return { line: next, label: unquote(labelField.replace(UTF8_BOM_LATIN1, '')).trim(), found: true };
}

function scrubColumns(lines: string[], from: number, edits: readonly [string, string][], replaced: Set<string>): string[] {
  const headerIndex = lines.findIndex(
    (line, index) => index >= from && edits.some(([column]) => splitCsvFields(line).map(unquote).includes(column)),
  );
  if (headerIndex === -1) throw new Error(`column(s) not found: ${edits.map(([column]) => column).join(', ')}`);
  const header = splitCsvFields(lines[headerIndex] ?? '').map(unquote);
  const positions = edits.map(([column, value]) => {
    const position = header.indexOf(column);
    if (position === -1) throw new Error(`column not found: ${column}`);
    return { column, value, position };
  });
  let inTable = true;
  return lines.map((line, index) => {
    if (index <= headerIndex || !inTable) return line;
    if (line.trim() === '') {
      inTable = false;
      return line;
    }
    const fields = splitCsvFields(line);
    for (const { column, value, position } of positions) {
      const field = fields[position];
      if (field === undefined) continue;
      const next = replaceField(field, value);
      if (next !== field) replaced.add(column);
      fields[position] = next;
    }
    return fields.join(',');
  });
}

/** Scrubs a Dhan Journal-style CSV: the metadata block before the first blank line, plus optional data columns. */
export function scrubJournalCsv(bytes: Buffer, options: CsvScrubOptions): CsvScrubResult {
  const parts = bytes.toString('latin1').split(/(\r\n|\r|\n)/);
  const lines = parts.filter((_, index) => index % 2 === 0);
  const separators = parts.filter((_, index) => index % 2 === 1);
  const replaced = new Set<string>();
  const firstBlank = lines.findIndex((line) => line.replace(UTF8_BOM_LATIN1, '').trim() === '');
  const metadataEnd = firstBlank === -1 ? 0 : firstBlank;

  let found = 0;
  let scrubbed = lines.map((line, index) => {
    if (index >= metadataEnd) return line;
    const result = scrubMetadataLine(line);
    if (result.found) found += 1;
    if (result.label) replaced.add(result.label);
    return result.line;
  });
  if (options.expectMetadata && found === 0) throw new Error('no metadata labels found; refusing to guess');

  const edits = Object.entries(options.replaceColumns ?? {});
  if (edits.length > 0) scrubbed = scrubColumns(scrubbed, metadataEnd, edits, replaced);

  const text = scrubbed.map((line, index) => line + (separators[index] ?? '')).join('');
  const changedLines = scrubbed.filter((line, index) => line !== lines[index]).length;
  return { bytes: Buffer.from(text, 'latin1'), replaced: [...replaced], changedLines };
}

export interface CellChange {
  /** `Sheet!A1`, optionally suffixed `#link` / `#comment`. */
  readonly cell: string;
  readonly reason: string;
  readonly from: string;
  /** Replacement of the same length as `from`, so binary patching stays valid. */
  readonly to: string;
}

/** Header blocks are at the top of each sheet; labels further down are table headers, not personal data. */
const HEADER_BLOCK_ROWS = 15;
const LABEL_LOOKAHEAD_COLUMNS = 6;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ALLOWED_EMAIL = /@(dhan\.co|zerodha\.com)$/i;

/** `placeholder` padded with spaces to `length`, or `X…` when it doesn't fit. */
function redactToLength(placeholder: string, length: number): string {
  return placeholder.length <= length ? placeholder.padEnd(length, ' ') : 'X'.repeat(length);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces the value of a cell, keeping its hyperlink and comments. */
function setCellText(sheet: XLSX.WorkSheet, ref: string, value: string): void {
  const previous = sheet[ref] as XLSX.CellObject | undefined;
  sheet[ref] = { ...(previous?.l ? { l: previous.l } : {}), ...(previous?.c ? { c: previous.c } : {}), t: 's', v: value };
}

/** Same-length redaction of free text: personal emails, `Clt <code>` references and denylist terms. */
export function redactText(text: string, denyPatterns: readonly RegExp[]): string {
  let next = text.replace(EMAIL_IN_TEXT, (email) =>
    ALLOWED_EMAIL.test(email) || isPlaceholderValue('email', email) ? email : fitPlaceholder('email', email.length),
  );
  next = next.replace(DEMAT_PATTERN, (_match, label: string, number: string) => label + redactDematNumber(number));
  next = next.replace(
    /(?<![A-Za-z0-9])Clt([\s_]+)([A-Za-z0-9]+)/g,
    (_match, space: string, id: string) => `Clt${space}${redactToLength(PLACEHOLDERS.ucc, id.length)}`,
  );
  for (const pattern of denyPatterns) {
    next = next.replace(pattern, (match) => redactToLength(PLACEHOLDERS.name, match.length));
  }
  return next;
}

function scrubHeaderBlock(sheet: XLSX.WorkSheet, sheetName: string, range: XLSX.Range, changes: Map<string, CellChange>): void {
  const lastRow = Math.min(range.e.r, range.s.r + HEADER_BLOCK_ROWS - 1);
  for (let row = range.s.r; row <= lastRow; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const labelRef = XLSX.utils.encode_cell({ r: row, c: col });
      const labelCell = sheet[labelRef] as XLSX.CellObject | undefined;
      if (typeof labelCell?.v !== 'string') continue;
      const inline = /^([^:]+:\s*)(.+?)\s*$/.exec(labelCell.v);
      const inlineKey = inline ? labelKey(inline[1] ?? '') : undefined;
      if (inline && inlineKey) {
        const prefix = inline[1] ?? '';
        const value = inline[2] ?? '';
        if (!isPlaceholderValue(inlineKey, value) && !/^\d{1,5}$/.test(value)) {
          // Replace by position (after the colon), never by search, so the label itself is never touched.
          const next = prefix + fitPlaceholder(inlineKey, value.length) + labelCell.v.slice(prefix.length + value.length);
          setCellText(sheet, labelRef, next);
          changes.set(`${sheetName}!${labelRef}`, { cell: `${sheetName}!${labelRef}`, reason: `inline:${inlineKey}`, from: labelCell.v, to: next });
        }
        continue;
      }
      const key = labelKey(labelCell.v);
      if (key === undefined) continue;
      for (let next = col + 1; next <= Math.min(range.e.c, col + LABEL_LOOKAHEAD_COLUMNS); next += 1) {
        const ref = XLSX.utils.encode_cell({ r: row, c: next });
        const valueCell = sheet[ref] as XLSX.CellObject | undefined;
        if (valueCell?.v === undefined || valueCell.v === '') continue;
        const from = String(valueCell.v);
        // A 1–5 digit value (e.g. a stray 0 next to "Mobile") cannot identify anyone; leave the bytes alone.
        if (/^\d{1,5}$/.test(from) || isPlaceholderValue(key, from)) break;
        const to = fitPlaceholder(key, from.length);
        setCellText(sheet, ref, to);
        changes.set(`${sheetName}!${ref}`, { cell: `${sheetName}!${ref}`, reason: `header:${key}`, from, to });
        break;
      }
    }
  }
}

function scrubCellTexts(sheet: XLSX.WorkSheet, sheetName: string, denyPatterns: readonly RegExp[], changes: Map<string, CellChange>): void {
  for (const [ref, raw] of Object.entries(sheet)) {
    if (ref.startsWith('!')) continue;
    const cell = raw as XLSX.CellObject;
    const id = `${sheetName}!${ref}`;
    if (typeof cell.v === 'string') {
      const next = redactText(cell.v, denyPatterns);
      if (next !== cell.v) {
        changes.set(id, { cell: id, reason: 'text', from: changes.get(id)?.from ?? cell.v, to: next });
        setCellText(sheet, ref, next);
      }
    }
    const current = sheet[ref] as XLSX.CellObject;
    for (const field of ['Target', 'Tooltip'] as const) {
      const value = current.l?.[field];
      if (typeof value !== 'string' || !current.l) continue;
      const next = redactText(value, denyPatterns);
      if (next === value) continue;
      current.l[field] = next;
      changes.set(`${id}#${field}`, { cell: `${id}#${field}`, reason: 'link', from: value, to: next });
    }
    for (const [index, comment] of (current.c ?? []).entries()) {
      // Comment authors are people: always redact them (same length, so .xls stays patchable).
      const author = comment.a ?? '';
      if (author.trim() !== '' && !/^X+$/.test(author)) {
        const redacted = 'X'.repeat(author.length);
        changes.set(`${id}#author${index}`, { cell: `${id}#author${index}`, reason: 'comment-author', from: author, to: redacted });
        comment.a = redacted;
      }
      const next = redactText(comment.t, denyPatterns);
      if (next === comment.t) continue;
      changes.set(`${id}#comment${index}`, { cell: `${id}#comment${index}`, reason: 'comment', from: comment.t, to: next });
      comment.t = next;
    }
  }
}

/** Scrubs a workbook in place (SheetJS objects are mutable) and lists every change as a same-length edit. */
export function scrubWorkbook(workbook: XLSX.WorkBook, denyTerms: readonly string[]): CellChange[] {
  const denyPatterns = denyTerms
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .map((term) => new RegExp(escapeRegExp(term), 'gi'));
  const changes = new Map<string, CellChange>();
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const ref = sheet?.['!ref'];
    if (!sheet || ref === undefined) continue;
    scrubHeaderBlock(sheet, sheetName, XLSX.utils.decode_range(ref), changes);
    scrubCellTexts(sheet, sheetName, denyPatterns, changes);
  }
  return [...changes.values()];
}

/** Removes client IDs from export file names (Dhan: 9+ digit runs; Zerodha: `AB1234`-style tokens). */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/(?<!\d)\d{9,}(?!\d)/g, PLACEHOLDERS.ucc)
    .replace(/(?<=[-_])[A-Za-z]{2,3}\d{3,6}(?=[-_.])/g, PLACEHOLDERS.clientId);
}
