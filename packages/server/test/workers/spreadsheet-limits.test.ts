// S5a security-review follow-ups: zip-bomb pre-checks, cell/sheet caps, hostile sheet names.
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { parseWorkbook } from '../../src/workers/spreadsheet-core.mjs';
import { inspectZip, readSpreadsheet, SpreadsheetError } from '../../src/workers/spreadsheet.js';

/** Hand-builds a stored (uncompressed) zip whose central directory declares `declaredSize` per entry. */
function fakeZip(entries: number, declaredSize: number, compressedSize = 1): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (let index = 0; index < entries; index += 1) {
    const name = Buffer.from(`f${String(index)}.xml`, 'latin1');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    const data = Buffer.alloc(compressedSize);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(declaredSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries, 8);
  end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function xlsx(build: (book: XLSX.WorkBook) => void): Buffer {
  const book = XLSX.utils.book_new();
  build(book);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('inspectZip (before any decompression)', () => {
  it('accepts a real workbook', () => {
    const file = xlsx((book) => {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a']]), 'S');
    });
    expect(inspectZip(file).entries).toBeGreaterThan(0);
  });

  it('rejects a declared uncompressed size above the cap (zip bomb)', () => {
    expect(() => inspectZip(fakeZip(1, 1_000_000_000))).toThrow(/too large when unpacked/);
  });

  it('rejects an extreme compression ratio even under the size cap', () => {
    expect(() => inspectZip(fakeZip(1, 50_000_000, 10))).toThrow(/too large when unpacked/);
  });

  it('rejects too many entries', () => {
    expect(() => inspectZip(fakeZip(600, 10, 10))).toThrow(/too many parts/);
  });

  it('rejects a zip without a valid central directory', () => {
    expect(() => inspectZip(Buffer.from('PK\u0003\u0004 truncated', 'latin1'))).toThrow(SpreadsheetError);
  });

  it('is applied by readSpreadsheet before the worker starts', async () => {
    await expect(readSpreadsheet(fakeZip(1, 1_000_000_000))).rejects.toThrow(/too large when unpacked/);
  });
});

describe('parseWorkbook limits (in-process)', () => {
  const limits = { maxRows: 200_000, maxColumns: 1_000, maxCells: 1_000, maxSheets: 3 };

  it('rejects a sparse sheet whose range implies too many cells', () => {
    const file = xlsx((book) => {
      const sheet = XLSX.utils.aoa_to_sheet([['a']]);
      sheet.Z500 = { t: 's', v: 'far away' };
      sheet['!ref'] = 'A1:Z500';
      XLSX.utils.book_append_sheet(book, sheet, 'S');
    });
    expect(parseWorkbook(file, limits)).toEqual({ ok: false, code: 'too_many_cells' });
  });

  it('rejects too many sheets', () => {
    const file = xlsx((book) => {
      for (const name of ['A', 'B', 'C', 'D'])
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[1]]), name);
    });
    expect(parseWorkbook(file, limits)).toEqual({ ok: false, code: 'too_many_sheets' });
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the hostile sheet name %s', (name) => {
    const file = xlsx((book) => {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([[1]]), name);
    });
    expect(parseWorkbook(file, limits)).toEqual({ ok: false, code: 'bad_sheet_name' });
  });

  it('returns only plain cell values', () => {
    const file = xlsx((book) => {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['x', 1, true, null]]), 'S');
    });
    expect(parseWorkbook(file, limits)).toEqual({
      ok: true,
      sheets: [{ name: 'S', rows: [['x', 1, true, null]] }],
    });
  });

  it('reports unreadable bytes with a code only', () => {
    expect(parseWorkbook(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), limits)).toEqual({
      ok: false,
      code: 'unreadable',
    });
  });
});
