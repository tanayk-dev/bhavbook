// Setup and mistake tags: the query, the edits, and checks on what the server returns (responses are untrusted
// JSON).
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

export type TagKind = 'setup' | 'mistake';

export interface Tag {
  readonly id: string;
  readonly kind: TagKind;
  readonly name: string;
  readonly uses: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function tag(value: unknown): Tag {
  if (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'setup' || value.kind === 'mistake') &&
    typeof value.name === 'string' &&
    count(value.uses)
  ) {
    return { id: value.id, kind: value.kind, name: value.name, uses: value.uses };
  }
  throw new ApiError(200, 'unexpected_response');
}

export function tags(body: unknown): Tag[] {
  if (isRecord(body) && Array.isArray(body.tags)) return body.tags.map(tag);
  throw new ApiError(200, 'unexpected_response');
}

export const tagsQuery = queryOptions({
  queryKey: ['tags'],
  queryFn: async () => tags(await readJson(await send(() => api.tags.$get()))),
});

function field(body: unknown, name: string): number {
  const value = isRecord(body) ? body[name] : undefined;
  if (count(value)) return value;
  throw new ApiError(200, 'unexpected_response');
}

export async function createTag(kind: TagKind, name: string): Promise<void> {
  await readJson(await send(() => api.tags.$post({ json: { kind, name } })));
}

export async function renameTag(id: string, name: string): Promise<void> {
  await readJson(await send(() => api.tags[':id'].$patch({ param: { id }, json: { name } })));
}

/** Deletes a tag; returns how many journal entries lost it. */
export async function deleteTag(id: string): Promise<number> {
  return field(await readJson(await send(() => api.tags[':id'].$delete({ param: { id } }))), 'detached');
}

/** Merges a tag into another of its kind; returns how many journal entries had the merged tag. */
export async function mergeTag(id: string, intoId: string): Promise<number> {
  return field(
    await readJson(await send(() => api.tags[':id'].merge.$post({ param: { id }, json: { intoId } }))),
    'merged',
  );
}
