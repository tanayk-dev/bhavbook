// Query definitions shared by routes and tests. Responses are read as untrusted JSON and checked here.
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

export interface VaultStatus {
  readonly schemaVersion: number;
}

export function vaultStatus(body: unknown): VaultStatus {
  if (
    typeof body === 'object' &&
    body !== null &&
    'schemaVersion' in body &&
    typeof body.schemaVersion === 'number' &&
    Number.isInteger(body.schemaVersion) &&
    body.schemaVersion > 0
  ) {
    return { schemaVersion: body.schemaVersion };
  }
  throw new ApiError(200, 'unexpected_response');
}

export const vaultQuery = queryOptions({
  queryKey: ['vault'],
  queryFn: async () => vaultStatus(await readJson(await send(() => api.vault.$get()))),
});
