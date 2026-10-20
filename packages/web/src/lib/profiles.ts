// Profiles and broker accounts: the query, the two creating mutations, and checks on what the server returns
// (responses are untrusted JSON). Server error codes become messages a person can act on.
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, readJson, send } from '@/lib/api';

export const BROKERS = [
  { id: 'zerodha', label: 'Zerodha' },
  { id: 'dhan', label: 'Dhan' },
] as const;
export type BrokerId = (typeof BROKERS)[number]['id'];

export interface Account {
  readonly id: string;
  readonly broker: string;
  readonly nickname: string;
}

export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly accounts: readonly Account[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;
const text = (value: unknown): value is string => typeof value === 'string';

function account(value: unknown): Account {
  if (isRecord(value) && text(value.id) && text(value.broker) && text(value.nickname)) {
    return { id: value.id, broker: value.broker, nickname: value.nickname };
  }
  throw new ApiError(200, 'unexpected_response');
}

export function profiles(body: unknown): Profile[] {
  if (!isRecord(body) || !Array.isArray(body.profiles)) throw new ApiError(200, 'unexpected_response');
  return body.profiles.map((value: unknown) => {
    if (isRecord(value) && text(value.id) && text(value.name) && Array.isArray(value.accounts)) {
      return { id: value.id, name: value.name, accounts: value.accounts.map(account) };
    }
    throw new ApiError(200, 'unexpected_response');
  });
}

function createdId(body: unknown): string {
  if (isRecord(body) && text(body.id)) return body.id;
  throw new ApiError(200, 'unexpected_response');
}

export const profilesQuery = queryOptions({
  queryKey: ['profiles'],
  queryFn: async () => profiles(await readJson(await send(() => api.profiles.$get()))),
});

export async function createProfile(name: string): Promise<string> {
  return createdId(await readJson(await send(() => api.profiles.$post({ json: { name } }))));
}

export async function createAccount(input: {
  readonly profileId: string;
  readonly broker: BrokerId;
  readonly nickname: string;
}): Promise<string> {
  return createdId(await readJson(await send(() => api.accounts.$post({ json: input }))));
}

const SAVE_ERRORS: Readonly<Record<string, string>> = {
  identifier: 'That looks like a client ID or PAN. Choose a name of your own.',
  invalid: 'Use 1 to 40 letters, digits or spaces, without line breaks.',
  invalid_request: 'Use 1 to 40 letters, digits or spaces, without line breaks.',
  not_found: 'That profile no longer exists. Reload the page and try again.',
  recompute_failed: "This account's positions could not be rebuilt, so nothing was moved.",
};

const CONFLICTS = {
  profile: 'You already have a profile with this name.',
  account: 'This profile already has an account with this nickname.',
  tag: 'You already have a tag of this kind with this name.',
} as const;

/** What to tell the person when saving failed. */
export function saveError(error: unknown, what: keyof typeof CONFLICTS): string {
  if (!(error instanceof ApiError)) return 'Could not save. Try again.';
  if (error.code === 'conflict') return CONFLICTS[what];
  if (error.code === 'not_found' && what === 'tag') return 'That tag no longer exists. Reload the page.';
  return SAVE_ERRORS[error.code] ?? 'Could not save. Try again.';
}
