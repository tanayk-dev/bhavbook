// Settings: the query, the edits, and checks on what the server returns (responses are untrusted JSON).
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

export interface FeeRuleVersion {
  readonly id: string;
  readonly kind: 'statutory' | 'broker';
  readonly effectiveFrom: string;
  readonly charges: number;
}

export interface Settings {
  readonly breakevenThresholdMicro: bigint;
  readonly feeRules: readonly FeeRuleVersion[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function feeRule(value: unknown): FeeRuleVersion {
  if (
    isRecord(value) &&
    typeof value.id === 'string' &&
    (value.kind === 'statutory' || value.kind === 'broker') &&
    typeof value.effectiveFrom === 'string' &&
    typeof value.charges === 'number'
  ) {
    return { id: value.id, kind: value.kind, effectiveFrom: value.effectiveFrom, charges: value.charges };
  }
  throw new ApiError(200, 'unexpected_response');
}

export function settings(body: unknown): Settings {
  if (
    isRecord(body) &&
    typeof body.breakevenThresholdMicro === 'string' &&
    /^\d+$/.test(body.breakevenThresholdMicro) &&
    Array.isArray(body.feeRules)
  ) {
    return {
      breakevenThresholdMicro: BigInt(body.breakevenThresholdMicro),
      feeRules: body.feeRules.map(feeRule),
    };
  }
  throw new ApiError(200, 'unexpected_response');
}

export const settingsQuery = queryOptions({
  queryKey: ['settings'],
  queryFn: async () => settings(await readJson(await send(() => api.settings.$get()))),
});

export async function saveBreakeven(rupees: string): Promise<void> {
  await readJson(await send(() => api.settings.$put({ json: { breakevenThresholdRupees: rupees } })));
}

export async function renameProfile(id: string, name: string): Promise<void> {
  await readJson(await send(() => api.profiles[':id'].$patch({ param: { id }, json: { name } })));
}

export async function renameAccount(id: string, nickname: string): Promise<void> {
  await readJson(await send(() => api.accounts[':id'].$patch({ param: { id }, json: { nickname } })));
}

/** Moves an account and returns how many positions its recompute rebuilt. */
export async function moveAccount(id: string, profileId: string): Promise<number> {
  const body = await readJson(
    await send(() => api.accounts[':id'].move.$post({ param: { id }, json: { profileId } })),
  );
  if (isRecord(body) && typeof body.recomputed === 'number') return body.recomputed;
  throw new ApiError(200, 'unexpected_response');
}
