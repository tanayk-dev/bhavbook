// S13a-3a: the settings page against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRupees } from '@/components/settings';
import { formatIstDate } from '@/lib/format';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

interface StubAccount {
  id: string;
  broker: string;
  nickname: string;
}
interface StubProfile {
  id: string;
  name: string;
  accounts: StubAccount[];
}

const RECOMPUTE_FAILED = "This account's positions could not be rebuilt, so nothing was moved.";

function server() {
  const state = {
    breakeven: '0',
    profiles: [
      { id: 'p1', name: 'Swing', accounts: [{ id: 'a1', broker: 'dhan', nickname: 'D main' }] },
      { id: 'p2', name: 'Long-term', accounts: [] },
    ] as StubProfile[],
    moves: [] as { id: string; profileId: string }[],
  };
  const routes: Routes = {
    'GET /api/profiles': () => ({ body: { profiles: state.profiles } }),
    'GET /api/tags': { body: { tags: [] } },
    'GET /api/settings': () => ({
      body: {
        breakevenThresholdMicro: state.breakeven,
        feeRules: [
          { id: 'nse/2024-10-01', kind: 'statutory', effectiveFrom: '2024-10-01', charges: 1234 },
          { id: 'dhan/2024-04-01', kind: 'broker', effectiveFrom: '2024-04-01', charges: 0 },
        ],
      },
    }),
    // The real server's rule: up to 7 whole digits, at most 2 decimals.
    'PUT /api/settings': (body) => {
      const rupees = (body as { breakevenThresholdRupees: string }).breakevenThresholdRupees;
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(rupees)) return { status: 400, body: { error: 'invalid_request' } };
      const [whole = '0', fraction = ''] = rupees.split('.');
      state.breakeven = (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
      return { body: {} };
    },
    'PATCH /api/profiles/p1': (body) => {
      const { name } = body as { name: string };
      if (name.toLowerCase() === 'long-term') return { status: 409, body: { error: 'conflict' } };
      const profile = state.profiles[0];
      if (profile !== undefined) profile.name = name;
      return { body: { ok: true } };
    },
    'POST /api/accounts/a1/move': (body) => {
      const { profileId } = body as { profileId: string };
      state.moves.push({ id: 'a1', profileId });
      const account = state.profiles[0]?.accounts.pop();
      if (account !== undefined)
        state.profiles.find((profile) => profile.id === profileId)?.accounts.push(account);
      return { body: { moved: true, recomputed: 7 } };
    },
  };
  return { state, routes };
}

function renderSettings(routes: Routes) {
  stubServer(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/settings'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('formatting and parsing', () => {
  it('formats IST dates as dd MMM yyyy and leaves anything else alone', () => {
    expect(formatIstDate('2024-10-01')).toBe('01 Oct 2024');
    expect(formatIstDate('2024-13-01')).toBe('2024-13-01');
    expect(formatIstDate('soon')).toBe('soon');
  });

  it('parses rupees the way Indian users type them, and says what is wrong', () => {
    expect(parseRupees('₹1,00,000')).toEqual({ value: '100000' });
    expect(parseRupees(' .5 ')).toEqual({ value: '0.5' });
    expect(parseRupees('007')).toEqual({ value: '7' });
    expect(parseRupees('10,00,000.00')).toEqual({ value: '1000000.00' });
    expect(parseRupees('1.234')).toEqual({ error: 'Use at most two decimals (paise).' });
    expect(parseRupees('10,00,000.01')).toEqual({ error: 'The threshold can be at most ₹10,00,000.' });
    expect(parseRupees('20000000')).toEqual({ error: 'The threshold can be at most ₹10,00,000.' });
    expect(parseRupees('-5')).toEqual({ error: 'Enter an amount in rupees, for example 10 or 12.50.' });
  });
});

describe('rename', () => {
  it('renames a profile inline, explains a clash, Escape cancels, and focus returns each time', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Swing' }));
    const field = screen.getByLabelText('New profile name');
    expect(field).toHaveFocus();
    await userEvent.clear(field);
    await userEvent.type(field, 'Long-term{Enter}');
    expect(await screen.findByText('You already have a profile with this name.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rename Swing' })).toHaveFocus();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Rename Swing' }));
    await userEvent.clear(screen.getByLabelText('New profile name'));
    await userEvent.type(screen.getByLabelText('New profile name'), 'Swing trades{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Rename Swing trades' })).toHaveFocus();
    });
    expect(await screen.findByText('Renamed the profile to Swing trades.')).toBeInTheDocument();
    expect(state.profiles[0]?.name).toBe('Swing trades');
  });
});

describe('move', () => {
  it('moves an account only after confirming; focus follows each step; the recompute is reported', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    const confirm = screen.getByRole('group', { name: 'Confirm moving D main' });
    expect(confirm).toHaveTextContent('Move D main to Long-term? Its positions are recomputed.');
    expect(within(confirm).getByRole('button', { name: 'Move and recompute' })).toHaveFocus();
    expect(state.moves).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Move and recompute' }));
    expect(
      await screen.findByText('Moved D main to Long-term and recomputed 7 positions.'),
    ).toBeInTheDocument();
    expect(state.moves).toEqual([{ id: 'a1', profileId: 'p2' }]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Move…' })).toHaveFocus();
    });
    expect(screen.queryByRole('group', { name: 'Confirm moving D main' })).toBeNull();
    expect(screen.getByLabelText('Move D main to')).toHaveDisplayValue('Swing');
  });

  it('a move can be cancelled, and focus returns to Move…', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Move…' })).toHaveFocus();
    });
    expect(state.moves).toEqual([]);
  });

  it('explains a move whose recompute fails, and Cancel clears the error', async () => {
    const { routes } = server();
    renderSettings({
      ...routes,
      'POST /api/accounts/a1/move': () => ({ status: 409, body: { error: 'recompute_failed' } }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move and recompute' }));
    expect(await screen.findByText(RECOMPUTE_FAILED)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    expect(screen.queryByText(RECOMPUTE_FAILED)).toBeNull();
  });

  it('a one-position recompute is singular', async () => {
    const { routes } = server();
    renderSettings({
      ...routes,
      'POST /api/accounts/a1/move': () => ({ body: { moved: true, recomputed: 1 } }),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move and recompute' }));
    expect(
      await screen.findByText('Moved D main to Long-term and recomputed 1 position.'),
    ).toBeInTheDocument();
  });

  it('with one profile there is nowhere to move to', async () => {
    const { state, routes } = server();
    state.profiles.pop();
    renderSettings(routes);
    expect(await screen.findByText('Create another profile to move it.')).toBeInTheDocument();
  });
});

describe('breakeven and fee rules', () => {
  it('saves the threshold, announces it, and explains a bad value before sending it', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    const field = await screen.findByLabelText('New threshold (₹)');
    await userEvent.type(field, 'abc{Enter}');
    expect(
      await screen.findByText('Enter an amount in rupees, for example 10 or 12.50.'),
    ).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(field);
    await userEvent.type(field, '₹1,000.5{Enter}');
    expect(await screen.findByText('Breakeven threshold saved: ₹1000.5.')).toBeInTheDocument();
    expect(state.breakeven).toBe('1000500000');
  });

  it('lists the fee-rule versions, read-only', async () => {
    renderSettings(server().routes);
    const row = await screen.findByRole('row', { name: /nse\/2024-10-01/ });
    expect(row).toHaveTextContent('Exchange and taxes');
    expect(row).toHaveTextContent('01 Oct 2024');
    expect(row).toHaveTextContent('1,234');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('with no profiles, points to onboarding', async () => {
    const { state, routes } = server();
    state.profiles.splice(0);
    renderSettings(routes);
    expect(
      await screen.findByRole('link', { name: 'Set up a profile and a broker account' }),
    ).toBeInTheDocument();
  });
});
