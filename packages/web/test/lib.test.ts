// S13a-1: the launch-token strip (ADR-0002), the API error mapping, the theme preference and response checks.
import { describe, expect, it, vi } from 'vitest';
import { ApiError, readJson } from '@/lib/api';
import { vaultStatus } from '@/lib/queries';
import { stripLaunchToken } from '@/lib/session';
import { applyTheme, storedTheme } from '@/lib/theme';

describe('stripLaunchToken', () => {
  it('removes t= from the address bar without a navigation, keeping the rest of the URL', () => {
    const replaceState = vi.fn();
    const stripped = stripLaunchToken(
      { href: 'http://127.0.0.1:4000/settings?t=SECRET&tab=tags#accounts' },
      {
        replaceState,
        state: null,
      },
    );
    expect(stripped).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/settings?tab=tags#accounts');
  });

  it('leaves a clean URL alone', () => {
    const replaceState = vi.fn();
    expect(stripLaunchToken({ href: 'http://127.0.0.1:4000/' }, { replaceState, state: null })).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('readJson', () => {
  it('returns the body of a successful response', async () => {
    expect(await readJson(Response.json({ schemaVersion: 3 }))).toEqual({ schemaVersion: 3 });
  });

  it.each([
    [401, { error: 'unauthorized' }, 'unauthorized', true],
    [403, { error: 'forbidden' }, 'forbidden', true],
    [501, { error: 'not_implemented' }, 'not_implemented', false],
    [500, 'not json', 'unexpected_response', false],
  ])('maps a %i to ApiError(%o)', async (status, body, code, sessionEnded) => {
    const response =
      typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });
    const error = await readJson(response).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect([(error as ApiError).code, (error as ApiError).sessionEnded]).toEqual([code, sessionEnded]);
  });
});

describe('vaultStatus', () => {
  it('accepts the server shape and rejects anything else', () => {
    expect(vaultStatus({ schemaVersion: 3 })).toEqual({ schemaVersion: 3 });
    expect(() => vaultStatus({ schemaVersion: '3' })).toThrow(ApiError);
    expect(() => vaultStatus(null)).toThrow(ApiError);
  });
});

describe('theme', () => {
  it('defaults to light, remembers dark, and survives storage that throws', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    };
    expect(storedTheme(storage)).toBe('light');
    const root = document.createElement('html');
    applyTheme('dark', root, storage);
    expect([root.classList.contains('dark'), storedTheme(storage)]).toEqual([true, 'dark']);
    applyTheme('light', root, storage);
    expect(root.classList.contains('dark')).toBe(false);
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(storedTheme(broken)).toBe('light');
    expect(() => {
      applyTheme('dark', root, broken);
    }).not.toThrow();
    expect(storedTheme(undefined)).toBe('light');
  });
});
