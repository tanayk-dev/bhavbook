// PNG files for E2E tests, built byte by byte: a picture plus whatever metadata chunks a test wants it to carry
// (a location in a text chunk, an EXIF block), so a test can prove the browser's conversion drops them.
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export interface PngOptions {
  readonly width: number;
  readonly height: number;
  /** Random pixels (they compress badly, so the WebP is large) instead of a flat colour. */
  readonly noise?: boolean;
  /** Metadata chunks to carry: [type, contents]. */
  readonly metadata?: readonly (readonly [string, string])[];
}

export function png({ width, height, noise = false, metadata = [] }: PngOptions): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(2, 9); // RGB
  const row = width * 3;
  const pixels = Buffer.alloc((row + 1) * height, 0x80);
  for (let y = 0; y < height; y += 1) {
    pixels[y * (row + 1)] = 0; // filter: none
    if (noise) randomBytes(row).copy(pixels, y * (row + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...metadata.map(([type, text]) => chunk(type, Buffer.from(text, 'latin1'))),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
