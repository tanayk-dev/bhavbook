// Scans fixtures for personal data (plan invariant 3). Findings carry a masked sample only, so CI logs never
// expose a leaked value. Usage: `pnpm pii:scan [paths...]` (default: packages/*/fixtures).
//
// Layers: (1) text files line by line; (2) spreadsheets cell by cell, including hyperlinks, comments, sheet names,
// defined names and document properties; (3) every stream of the file container (each XML part of an .xlsx zip,
// each OLE stream of an .xls, in latin1 and UTF-16LE), which catches text SheetJS does not surface.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import { DEMAT_PATTERN, EMAIL_PLACEHOLDER_PATTERN, PLACEHOLDERS } from './placeholders.js';

export interface Finding {
  readonly kind: string;
  readonly location: string;
  readonly sample: string;
}

interface Detector {
  readonly kind: string;
  readonly pattern: RegExp;
  readonly allowed: (match: RegExpExecArray) => boolean;
  /** Safe to run over raw container bytes and XML (low false-positive rate). */
  readonly raw: boolean;
}

export interface ScanOptions {
  /** Raw container/XML text: skip detectors that misfire on markup (e.g. cell refs like `AB1234`). */
  readonly raw?: boolean;
}

const ALLOWED_EMAIL_DOMAINS = ['dhan.co', 'zerodha.com'];
// Letters/digits only; `_` and punctuation count as boundaries so IDs inside file names are caught.
const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';

const DETECTORS: readonly Detector[] = [
  {
    kind: 'pan',
    pattern: new RegExp(`${START}[A-Za-z]{5}\\d{4}[A-Za-z]${END}`, 'g'),
    allowed: (m) => m[0].toUpperCase() === PLACEHOLDERS.pan,
    raw: true,
  },
  {
    kind: 'email',
    pattern: /[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g,
    allowed: (m) =>
      EMAIL_PLACEHOLDER_PATTERN.test(m[0]) || ALLOWED_EMAIL_DOMAINS.includes((m[1] ?? '').toLowerCase()),
    raw: true,
  },
  {
    kind: 'mobile',
    // 9876543210, +91 98765 43210, +91-98765-43210, 09876543210 (but not a decimal amount such as 9876543210.50).
    pattern: new RegExp(`(?<![A-Za-z0-9.])(?:\\+?91[-\\s]?|0)?(\\d{5}[-\\s]?\\d{5})(?!\\.?\\d)${END}`, 'g'),
    allowed: (m) => (m[1] ?? '').replace(/[-\s]/g, '') === PLACEHOLDERS.mobile,
    raw: true,
  },
  {
    // Demat account (CDSL BOID: 8-digit DP ID + 8-digit client ID; NSDL: IN + 6 + 8). Only next to a label,
    // because broker order numbers are also 16 digits. The DP ID part is public; the client part must be zeroed.
    kind: 'demat-account',
    pattern: DEMAT_PATTERN,
    allowed: (m) => /0{8}$/.test(m[2] ?? ''),
    raw: true,
  },
  {
    // UPI handles have no dot in the domain (name@okaxis, name@ybl), so the email detector misses them.
    kind: 'upi-id',
    pattern: /(?<![\w.@-])[\w.-]{2,}@(?:ok(?:axis|hdfcbank|icici|sbi)|ybl|ibl|axl|paytm|apl|upi|fbl|ikwik|freecharge|yapl|jupiteraxis|slc|pthdfc|ptsbi|ptyes|ptaxis)(?![\w.])/gi,
    allowed: () => false,
    raw: true,
  },
  {
    kind: 'bank-account',
    // "Demat Account No." is handled by the demat detector, which keeps the public DP ID.
    pattern: /(?<!demat\s)(?<![A-Za-z0-9])(?:a\/?c|acct|account)(?:\s*(?:no|number))?\.?[^\d\n]{0,12}(\d{9,18})(?!\d)/gi,
    allowed: (m) => /^0+$/.test(m[1] ?? ''),
    raw: true,
  },
  {
    kind: 'ifsc',
    pattern: new RegExp(`${START}[A-Z]{4}0[A-Z0-9]{6}${END}`, 'g'),
    allowed: (m) => /^X{4}0X{6}$/.test(m[0]),
    raw: false,
  },
  {
    kind: 'aadhaar',
    // Grouped 4-4-4 only: an unseparated 12-digit run is indistinguishable from +91 mobiles and broker IDs.
    pattern: new RegExp(`${START}[2-9]\\d{3}[ -]\\d{4}[ -]\\d{4}${END}`, 'g'),
    allowed: () => false,
    raw: false,
  },
  {
    kind: 'date-of-birth',
    pattern: /(?:\bdob\b|date of birth|\bbirth date)[^\n]{0,20}\d{1,4}[-/ .]\w{1,9}[-/ .]\d{2,4}/gi,
    allowed: () => false,
    raw: true,
  },
  {
    kind: 'pin-code',
    pattern: /(?:\bpin\s?code|\bpostal code|\bzip)[^\d\n]{0,10}[1-9]\d{5}(?!\d)/gi,
    allowed: () => false,
    raw: true,
  },
  {
    kind: 'masked-mobile',
    pattern: new RegExp(`${START}\\d{2}X{4,}\\d{2}${END}`, 'g'),
    allowed: () => false,
    raw: true,
  },
  {
    kind: 'client-ref',
    // Client codes are alphanumeric; a narrower capture avoids running into adjacent binary bytes.
    pattern: new RegExp(`${START}Clt[\\s_]+([A-Za-z0-9]+)`, 'g'),
    allowed: (m) => m[1] === PLACEHOLDERS.ucc || /^X+$/.test(m[1] ?? ''),
    raw: true,
  },
  {
    kind: 'zerodha-client-id',
    pattern: new RegExp(`${START}[A-Z]{2,3}\\d{4,6}${END}`, 'g'),
    allowed: (m) => m[0] === PLACEHOLDERS.clientId,
    raw: false,
  },
];

const MIN_DENY_TERM = 3;
/** Document properties that can carry a person's name. Redacted values are all `X`. */
export const PERSONAL_PROPERTIES = [
  'Author',
  'LastAuthor',
  'Manager',
  'Company',
  'Title',
  'Subject',
  'Keywords',
  'Comments',
] as const;
const TEXT_EXTENSIONS = new Set(['.csv', '.txt', '.md', '.json', '.tsv', '.gitkeep', '']);
const SHEET_EXTENSIONS = new Set(['.xls', '.xlsx']);
const BINARY_EXTENSIONS = new Set(['.bhav', '.db', '.sqlite']);

/** Masks a value: short values are hidden entirely, longer ones show only their first 2 characters. */
export function mask(value: string): string {
  return value.length <= 4 ? '***' : `${value.slice(0, 2)}***`;
}

/** Scans one string; line numbers are appended to `location`. */
export function scanText(
  text: string,
  location: string,
  denyTerms: readonly string[],
  options: ScanOptions = {},
): Finding[] {
  const terms = denyTerms.map((term) => term.trim().toLowerCase()).filter((term) => term.length >= MIN_DENY_TERM);
  const detectors = options.raw ? DETECTORS.filter((detector) => detector.raw) : DETECTORS;
  const findings: Finding[] = [];
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    const where = `${location}:${index + 1}`;
    for (const detector of detectors) {
      for (const match of line.matchAll(detector.pattern)) {
        if (!detector.allowed(match)) findings.push({ kind: detector.kind, location: where, sample: mask(match[0]) });
      }
    }
    const lower = line.toLowerCase();
    for (const term of terms) {
      if (lower.includes(term)) findings.push({ kind: 'denylist', location: where, sample: mask(term) });
    }
  });
  return findings;
}

function scanValue(value: unknown, location: string, denyTerms: readonly string[]): Finding[] {
  if (typeof value !== 'string' && typeof value !== 'number') return [];
  return scanText(String(value), location, denyTerms).map((finding) => ({
    ...finding,
    location: finding.location.replace(/:\d+$/, ''),
  }));
}

/** Text a cell can carry beyond its value: hyperlink target and tooltip, and comment text. */
export function cellTexts(cell: XLSX.CellObject): { label: string; text: unknown }[] {
  const texts: { label: string; text: unknown }[] = [{ label: '', text: cell.v }];
  if (cell.l) texts.push({ label: '#link', text: cell.l.Target }, { label: '#tooltip', text: cell.l.Tooltip });
  for (const comment of cell.c ?? []) texts.push({ label: '#comment', text: comment.t });
  return texts;
}

function isUnredacted(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !/^X+$/.test(value.trim());
}

/**
 * Scans document and custom properties, defined names, sheet names and every cell (value, hyperlink, comment
 * text and author). Locations use the sheet number, never the sheet name, so names can't leak into logs.
 */
export function scanWorkbook(workbook: XLSX.WorkBook, location: string, denyTerms: readonly string[]): Finding[] {
  const findings: Finding[] = [];
  const props = (workbook.Props ?? {}) as Record<string, unknown>;
  for (const key of PERSONAL_PROPERTIES) {
    const value = props[key];
    if (isUnredacted(value)) findings.push({ kind: 'doc-property', location: `${location}#${key}`, sample: mask(value) });
  }
  const custom = (workbook.Custprops ?? {}) as Record<string, unknown>;
  for (const [key, value] of [...Object.entries(props), ...Object.entries(custom)]) {
    findings.push(...scanValue(value, `${location}#property`, denyTerms));
  }
  for (const name of workbook.Workbook?.Names ?? []) {
    findings.push(...scanValue(`${name.Name} ${name.Ref}`, `${location}#name`, denyTerms));
  }
  workbook.SheetNames.forEach((sheetName, index) => {
    const where = `${location}!sheet${index + 1}`;
    findings.push(...scanValue(sheetName, `${where}#sheet-name`, denyTerms));
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;
    for (const [ref, raw] of Object.entries(sheet)) {
      if (ref.startsWith('!')) continue;
      const cell = raw as XLSX.CellObject;
      for (const { label, text } of cellTexts(cell)) findings.push(...scanValue(text, `${where}!${ref}${label}`, denyTerms));
      for (const comment of cell.c ?? []) {
        if (isUnredacted(comment.a)) {
          findings.push({ kind: 'comment-author', location: `${where}!${ref}#author`, sample: mask(comment.a) });
        }
      }
    }
  });
  return findings;
}

/** UTF-16LE decoding of binary data, keeping only printable BMP text (no surrogates or control characters). */
function utf16Text(data: Buffer): string {
  return data
    .subarray(0, data.length - (data.length % 2))
    .toString('utf16le')
    .replace(/[\uD800-\uDFFF\u0000-\u0008\u000E-\u001F]+/g, ' ');
}

/** The subset of SheetJS's (loosely typed) CFB container we use. */
interface ContainerEntry {
  readonly name: string;
  readonly type: number;
  readonly content?: Uint8Array | number[];
}
interface Container {
  readonly FileIndex: readonly ContainerEntry[];
  readonly FullPaths: readonly string[];
}

/** Scans every stream inside the file container: XML parts of an .xlsx, OLE streams of an .xls. */
export function scanContainer(bytes: Buffer, location: string, denyTerms: readonly string[]): Finding[] {
  const container = XLSX.CFB.read(bytes, { type: 'buffer' }) as Container;
  return container.FileIndex.flatMap((entry, index) => {
    const content = entry.content;
    if (entry.type !== 2 || !content || content.length === 0) return [];
    const data = Buffer.from(content);
    const where = `${location}#${container.FullPaths[index] ?? entry.name}`;
    const isXml = /\.(xml|rels|vml)$/i.test(entry.name);
    if (!isXml && /\.(png|jpe?g|gif|emf|wmf|bin)$/i.test(entry.name)) return [];
    return isXml ? scanText(data.toString('utf8'), where, denyTerms, { raw: true }) : scanBinary(data, where, denyTerms);
  });
}

/**
 * Raw scan of binary bytes: latin1, plus UTF-16LE at both byte alignments (records can start at odd offsets).
 * Unpaired surrogates from decoding binary as UTF-16 are dropped: personal data is never in them, and V8's
 * case-insensitive regex engine can crash on long runs of them.
 */
export function scanBinary(data: Buffer, location: string, denyTerms: readonly string[]): Finding[] {
  return [data.toString('latin1'), utf16Text(data), utf16Text(data.subarray(1))].flatMap((text) =>
    scanText(text, location, denyTerms, { raw: true }),
  );
}

function listFiles(target: string): string[] {
  if (statSync(target).isFile()) return [target];
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => listFiles(path.join(target, entry.name)));
}

function scanFileName(file: string, denyTerms: readonly string[]): Finding[] {
  // Never echo the file name: it may be the leak.
  const where = `${path.dirname(file)}${path.sep}<file name>`;
  return scanText(path.basename(file), where, denyTerms).map((finding) => ({ ...finding, location: where }));
}

/** Scans files under the given paths. Missing paths, empty scans and unsupported file types are errors. */
export function scanPaths(targets: readonly string[], denyTerms: readonly string[]): Finding[] {
  if (targets.length === 0) throw new Error('pii:scan needs at least one path');
  for (const target of targets) {
    if (!existsSync(target)) throw new Error(`pii:scan path does not exist: ${target}`);
  }
  const files = targets.flatMap(listFiles);
  if (files.length === 0) throw new Error('pii:scan found no files to scan');
  return files.flatMap((file) => {
    const nameFindings = scanFileName(file, denyTerms);
    const extension = path.extname(file).toLowerCase();
    if (SHEET_EXTENSIONS.has(extension)) {
      const bytes = readFileSync(file);
      return [...nameFindings, ...scanWorkbook(XLSX.read(bytes), file, denyTerms), ...scanContainer(bytes, file, denyTerms)];
    }
    if (BINARY_EXTENSIONS.has(extension)) {
      // Vault backups and databases: no structure to walk, so scan every byte (also catches leaked rows).
      return [...nameFindings, ...scanBinary(readFileSync(file), file, denyTerms)];
    }
    if (TEXT_EXTENSIONS.has(extension)) {
      const bytes = readFileSync(file);
      const texts = [bytes.toString('latin1'), bytes.toString('utf8')];
      if (bytes[0] === 0xff && bytes[1] === 0xfe) texts.push(bytes.toString('utf16le'));
      return [...nameFindings, ...texts.flatMap((text) => scanText(text, file, denyTerms))];
    }
    return [...nameFindings, { kind: 'unsupported-file', location: `${path.dirname(file)}${path.sep}<file name>`, sample: extension || '(none)' }];
  });
}

/** Optional local denylist (one term per line), never committed: ~/.bhavbook-pii-denylist or $BHAVBOOK_PII_DENYLIST. */
export function loadDenylist(): string[] {
  const file = process.env.BHAVBOOK_PII_DENYLIST ?? path.join(homedir(), '.bhavbook-pii-denylist');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .replace(/^﻿/, '') // Windows PowerShell 5 writes UTF-8 with a BOM
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

function defaultTargets(repoRoot: string): string[] {
  const packagesDir = path.join(repoRoot, 'packages');
  return readdirSync(packagesDir)
    .map((name) => path.join(packagesDir, name, 'fixtures'))
    .filter((dir) => existsSync(dir));
}

function main(): void {
  const repoRoot = process.cwd();
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : defaultTargets(repoRoot);
  const denylist = loadDenylist();
  const findings = scanPaths(targets, denylist);
  const scope = `${targets.length} path(s), denylist ${denylist.length > 0 ? `${denylist.length} term(s)` : 'not found (CI mode)'}`;
  if (findings.length === 0) {
    console.log(`pii:scan OK (${scope})`);
    return;
  }
  console.error(`pii:scan found ${findings.length} potential personal-data value(s) (${scope}):`);
  for (const finding of findings) {
    console.error(`  [${finding.kind}] ${path.relative(repoRoot, finding.location)}  ${finding.sample}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
