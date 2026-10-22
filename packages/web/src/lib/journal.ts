// The journal (PRD §5.3, §10.1; plan S14a): saving an entry, screenshots, and merging two entries that collide on one
// position. Screenshots are re-encoded to WebP through a canvas in the browser, which drops EXIF, location and every
// other metadata block (ADR-0020, PRD §3.3), and shrunk until they fit in 1 MB; the server checks both again.
import { ApiError, readJson, send } from '@/lib/api';

export const MAX_SCREENSHOT_BYTES = 1024 * 1024;
const MAX_SIDE_PX = 2560;
const QUALITIES = [0.85, 0.7, 0.55, 0.4];
const SHRINK = 0.75;
const MIN_SIDE_PX = 320;
const MICRO_PER_RUPEE = 1_000_000n;
/** Decoding a bigger picture can exhaust the tab's memory; a screenshot never needs this many pixels. */
const MAX_PIXELS = 100_000_000;

/** The whole editable entry, as the server takes it: amounts are micro-rupees in decimal strings, null when empty. */
export interface JournalInput {
  readonly entryId?: string;
  /** The entry's `updatedAt` the form started from (null: none yet); the server refuses a stale save. */
  readonly expectedUpdatedAt?: string | null;
  readonly setupTagId: string | null;
  readonly mistakeTagIds: readonly string[];
  readonly thesis: string | null;
  readonly initialStopMicro: string | null;
  readonly plannedStopMicro: string | null;
  readonly plannedTargetMicro: string | null;
  readonly plannedRiskMicro: string | null;
  readonly reviewNote: string | null;
}

/**
 * A stored amount as the rupees a form shows, exactly: paise as two decimals, finer amounts (from older data or
 * the API) with up to six, never rounded. String arithmetic only.
 */
export function microToRupees(micro: bigint | null): string {
  if (micro === null) return '';
  const whole = micro / MICRO_PER_RUPEE;
  const fraction = (micro % MICRO_PER_RUPEE).toString().padStart(6, '0');
  if (fraction === '000000') return whole.toString();
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole.toString()}.${trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = (body: unknown): string => {
  if (isRecord(body) && typeof body.id === 'string') return body.id;
  throw new ApiError(200, 'unexpected_response');
};

const request = (method: string, path: string, init: RequestInit = {}) =>
  fetch(path, { method, credentials: 'same-origin', ...init });

/** Saves a position's journal entry (the server creates it on first save); returns its id. */
export async function saveJournal(ref: string, input: JournalInput): Promise<string> {
  const body = await readJson(
    await send(() =>
      request('PUT', `/api/positions/${encodeURIComponent(ref)}/journal`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    ),
  );
  return idOf(body);
}

/** The position's journal entry, created empty if it has none; an existing one is never changed. */
export async function ensureEntry(ref: string): Promise<string> {
  return idOf(
    await readJson(
      await send(() => request('POST', `/api/positions/${encodeURIComponent(ref)}/journal/entry`)),
    ),
  );
}

/** Stores a WebP screenshot (already converted) on an entry; returns its id. */
export async function uploadScreenshot(entryId: string, webp: Blob): Promise<string> {
  const body = await readJson(
    await send(() =>
      request('POST', `/api/journal/${encodeURIComponent(entryId)}/attachments`, {
        headers: { 'content-type': 'image/webp' },
        body: webp,
      }),
    ),
  );
  return idOf(body);
}

export async function deleteScreenshot(id: string): Promise<void> {
  await readJson(await send(() => request('DELETE', `/api/attachments/${encodeURIComponent(id)}`)));
}

/** Where a stored screenshot is served (same origin; the session cookie goes with it). */
export const screenshotUrl = (id: string): string => `/api/attachments/${encodeURIComponent(id)}`;

/** Merges the entries of a collision issue into the one kept. */
export async function mergeEntries(issueId: string, intoId: string): Promise<void> {
  await readJson(
    await send(() =>
      request('POST', `/api/issues/${encodeURIComponent(issueId)}/merge`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ intoId }),
      }),
    ),
  );
}

/** The position reference the server uses (its id in base64url), for an id an issue names. */
export function positionRefOf(positionId: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(positionId)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export class ScreenshotError extends Error {
  override readonly name = 'ScreenshotError';

  constructor(
    readonly reason: 'not_an_image' | 'too_many_pixels' | 'encode_failed' | 'no_webp' | 'too_large',
  ) {
    super(`screenshot not usable: ${reason}`);
  }
}

/** The pixels, without anything else the file carried; ScreenshotError when it is not an image the browser reads. */
async function decode(file: Blob): Promise<ImageBitmap> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new ScreenshotError('not_an_image');
  }
  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    bitmap.close();
    throw new ScreenshotError('too_many_pixels');
  }
  return bitmap;
}

async function encode(bitmap: ImageBitmap, scale: number, quality: number): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  // No context (out of memory): stop rather than store a blank picture.
  if (context === null) throw new ScreenshotError('encode_failed');
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/webp', quality);
  });
  if (blob === null) throw new ScreenshotError('encode_failed');
  // A browser that cannot encode WebP falls back to PNG: refuse rather than send something else.
  if (blob.type !== 'image/webp') throw new ScreenshotError('no_webp');
  return blob;
}

/**
 * Re-encodes an image (a paste, a drop or a picked file) to WebP through a canvas: only pixels survive, so EXIF,
 * location and other metadata never leave the browser. Tries lower qualities, then smaller sizes, until the result
 * fits in 1 MB.
 */
export async function toWebp(file: Blob): Promise<Blob> {
  const bitmap = await decode(file);
  try {
    let scale = Math.min(1, MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
    while (Math.max(bitmap.width, bitmap.height) * scale >= MIN_SIDE_PX || scale === 1) {
      for (const quality of QUALITIES) {
        const blob = await encode(bitmap, scale, quality);
        if (blob.size <= MAX_SCREENSHOT_BYTES) return blob;
      }
      scale *= SHRINK;
    }
    throw new ScreenshotError('too_large');
  } finally {
    bitmap.close();
  }
}

const SCREENSHOT_ERRORS: Readonly<Record<ScreenshotError['reason'], string>> = {
  not_an_image: 'That is not an image this browser can read.',
  too_many_pixels: 'That image is too big to convert here (over 100 megapixels).',
  encode_failed: 'The browser could not convert that image (it may be short of memory). Try a smaller one.',
  no_webp: 'This browser cannot make WebP images. Try a recent Chrome, Edge or Firefox.',
  too_large: 'That image stays over 1 MB even when shrunk.',
};

const SAVE_ERRORS: Readonly<Record<string, string>> = {
  stale:
    'This entry changed elsewhere (merged, reviewed or edited in another tab). Reload to see it, then make your changes again.',
  conflict:
    'The initial stop was recorded and the position has closed, so it is fixed (R stays honest). The other fields can change.',
  invalid: 'A tag is missing or of the wrong kind. Reload and try again.',
  invalid_request: 'Some values are malformed: amounts are rupees with at most two decimals.',
  not_found: 'This position changed meanwhile (new trades rebuilt it). Reload the page.',
};

const UPLOAD_ERRORS: Readonly<Record<string, string>> = {
  conflict: 'An entry holds at most 20 screenshots. Remove one first.',
  invalid: 'That image could not be stored: it was not a plain WebP picture.',
  not_found: 'This journal entry is gone (merged or rebuilt). Reload the page.',
  payload_too_large: 'That screenshot is over 1 MB.',
  unsupported_media_type: 'Only WebP screenshots are stored.',
};

const AGAIN = 'That did not work. Try again.';

/** What went wrong saving an entry, in words. */
export const saveError = (error: unknown): string =>
  (error instanceof ApiError ? SAVE_ERRORS[error.code] : undefined) ?? AGAIN;

/** What went wrong converting or storing a screenshot, in words. */
export function screenshotError(error: unknown): string {
  if (error instanceof ScreenshotError) return SCREENSHOT_ERRORS[error.reason];
  return (error instanceof ApiError ? UPLOAD_ERRORS[error.code] : undefined) ?? AGAIN;
}
