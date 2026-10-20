// S13a-1: the launch-token strip (ADR-0002), the API error mapping and retry policy, the theme, response checks.
import { describe, expect, it, vi } from 'vitest';
import { ApiError, readJson, send, shouldRetry } from '@/lib/api';
import { vaultStatus } from '@/lib/queries';
import { stripLaunchToken } from '@/lib/session';
import { applyTheme, currentTheme } from '@/lib/theme';

describe('stripLaunchToken', () => {
  it('removes t= from the address bar without a navigation, keeping the rest of the URL', () => {
    const replaceState = vi.fn();
    const stripped = stripLaunchToken(
      { href: 'http://127.0.0.1:4000/settings?t=SECRET&tab=tags#accounts' },
      { replaceState, state: { kept: true } },
    );
    expect(stripped).toBe(true);
    expect(replaceState).toHaveBeenCalledWith({ kept: true }, '', '/settings?tab=tags#accounts');
  });

  it('leaves a clean URL alone', () => {
    const replaceState = vi.fn();
    expect(stripLaunchToken({ href: 'http://127.0.0.1:4000/' }, { replaceState, state: null })).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('readJson and send', () => {
  it('returns the body of a successful response', async () => {
    expect(await readJson(Response.json({ schemaVersion: 3 }))).toEqual({ schemaVersion: 3 });
  });

  it.each([
    [401, { error: 'unauthorized' }, 'unauthorized', 'ended'],
    [403, { error: 'forbidden' }, 'forbidden', 'refused'],
    [501, { error: 'not_implemented' }, 'not_implemented', null],
    [500, 'not json', 'unexpected_response', null],
  ])('maps a %i to ApiError(%o)', async (status, body, code, disconnection) => {
    const response =
      typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status });
    const error = await readJson(response).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect([(error as ApiError).code, (error as ApiError).disconnection]).toEqual([code, disconnection]);
  });

  it('turns a network failure (no server) into ApiError(0), and passes other errors through', async () => {
    const stopped = await send(() => Promise.reject(new TypeError('Failed to fetch'))).catch(
      (cause: unknown) => cause,
    );
    expect([(stopped as ApiError).status, (stopped as ApiError).disconnection]).toEqual([0, 'stopped']);
    const other = new RangeError('x');
    await expect(send(() => Promise.reject(other))).rejects.toBe(other);
    const ok = Response.json({});
    expect(await send(() => Promise.resolve(ok))).toBe(ok);
  });
});

describe('shouldRetry', () => {
  it.each([
    [0, new ApiError(500, 'internal_error'), true],
    [0, new ApiError(0, 'unreachable'), true],
    [1, new ApiError(500, 'internal_error'), false],
    [0, new ApiError(404, 'not_found'), false],
    [0, new ApiError(501, 'not_implemented'), true],
    [0, new ApiError(401, 'unauthorized'), false],
    [0, new ApiError(200, 'unexpected_response'), false],
    [0, new Error('bug'), false],
  ])('after %i failures, %o -> %s', (failures, error, expected) => {
    expect(shouldRetry(failures, error)).toBe(expected);
  });
});

describe('vaultStatus', () => {
  it('accepts a positive whole schema version and rejects anything else', () => {
    expect(vaultStatus({ schemaVersion: 3 })).toEqual({ schemaVersion: 3 });
    for (const bad of [{ schemaVersion: '3' }, { schemaVersion: 2.5 }, { schemaVersion: 0 }, null]) {
      expect(() => vaultStatus(bad)).toThrow(ApiError);
    }
  });
});

describe('theme', () => {
  it('reads the live page state, remembers an explicit choice, and survives storage that throws', () => {
    const values = new Map<string, string>();
    const storage = { setItem: (key: string, value: string) => void values.set(key, value) };
    const root = document.createElement('html');
    expect(currentTheme(root)).toBe('light');
    applyTheme('dark', root, storage);
    expect([currentTheme(root), values.get('bhavbook.theme')]).toEqual(['dark', 'dark']);
    applyTheme('light', root, storage);
    expect(currentTheme(root)).toBe('light');
    const broken = {
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => {
      applyTheme('dark', root, broken);
    }).not.toThrow();
    expect(currentTheme(root)).toBe('dark');
    applyTheme('light', root, undefined);
    expect(currentTheme(root)).toBe('light');
  });
});
