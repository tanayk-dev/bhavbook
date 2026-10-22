// PNG files for E2E tests, built byte by byte: a picture plus whatever metadata chunks a test wants it to carry
// (a location in a text chunk, an EXIF block), so a test can prove the browser's conversion drops them.
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
  /** Noise (it compresses badly, so the WebP is large) instead of a flat colour; seeded, so every run is alike. */
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
  let seed = 0x2545f491;
  for (let y = 0; y < height; y += 1) {
    pixels[y * (row + 1)] = 0; // filter: none
    for (let x = 0; noise && x < row; x += 1) {
      // xorshift32: deterministic noise.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      pixels[y * (row + 1) + 1 + x] = seed & 0xff;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...metadata.map(([type, text]) => chunk(type, Buffer.from(text, 'latin1'))),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A JPEG with an EXIF block inserted after its start marker: orientation 6 (rotate 90° clockwise to display) and an
 * image description carrying `marker`, the way a phone camera writes its location and serial.
 */
export function withExif(jpeg: Buffer, marker: string): Buffer {
  const text = Buffer.from(`${marker}\0`, 'latin1');
  const entries = 2;
  const dataAt = 8 + 2 + entries * 12 + 4;
  const tiff = Buffer.alloc(dataAt + text.length);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(entries, 8);
  // Orientation (0x0112), SHORT, 1 value: 6.
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(6, 18);
  // ImageDescription (0x010e), ASCII, the marker, stored after the IFD.
  tiff.writeUInt16LE(0x010e, 22);
  tiff.writeUInt16LE(2, 24);
  tiff.writeUInt32LE(text.length, 26);
  tiff.writeUInt32LE(dataAt, 30);
  tiff.writeUInt32LE(0, 34); // no next IFD
  text.copy(tiff, dataAt);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

/** The chunk ids of a RIFF/WebP file, in order. */
export function webpChunks(bytes: Buffer): string[] {
  const ids: string[] = [];
  let at = 12;
  while (at + 8 <= bytes.length) {
    ids.push(bytes.toString('latin1', at, at + 4));
    const size = bytes.readUInt32LE(at + 4);
    at += 8 + size + (size % 2);
  }
  return ids;
}
