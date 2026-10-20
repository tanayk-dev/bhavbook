// S13a-3a: the settings page against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    'GET /api/settings': () => ({
      body: {
        breakevenThresholdMicro: state.breakeven,
        feeRules: [
          { id: 'nse/2024-10-01', kind: 'statutory', effectiveFrom: '2024-10-01', charges: 1234 },
          { id: 'dhan/2024-04-01', kind: 'broker', effectiveFrom: '2024-04-01', charges: 0 },
        ],
      },
    }),
    'PUT /api/settings': (body) => {
      const rupees = (body as { breakevenThresholdRupees: string }).breakevenThresholdRupees;
      if (!/^\d+(\.\d{1,2})?$/.test(rupees)) return { status: 400, body: { error: 'invalid_request' } };
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
      return { body: { recomputed: 7 } };
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

describe('settings', () => {
  it('formats IST dates as dd MMM yyyy and leaves anything else alone', () => {
    expect(formatIstDate('2024-10-01')).toBe('01 Oct 2024');
    expect(formatIstDate('2024-13-01')).toBe('2024-13-01');
    expect(formatIstDate('soon')).toBe('soon');
  });

  it('renames a profile inline, explains a clash, and Escape cancels', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Swing' }));
    const field = screen.getByLabelText('New profile name');
    expect(field).toHaveFocus();
    await userEvent.clear(field);
    await userEvent.type(field, 'Long-term{Enter}');
    expect(await screen.findByText('You already have a profile with this name.')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Rename Swing' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Rename Swing' }));
    await userEvent.clear(screen.getByLabelText('New profile name'));
    await userEvent.type(screen.getByLabelText('New profile name'), 'Swing trades{Enter}');
    expect(await screen.findByRole('button', { name: 'Rename Swing trades' })).toBeInTheDocument();
    expect(state.profiles[0]?.name).toBe('Swing trades');
  });

  it('moves an account only after confirming, and reports the recompute', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    const confirm = screen.getByRole('group', { name: 'Confirm moving D main' });
    expect(confirm).toHaveTextContent('Move D main to Long-term? Its positions are recomputed.');
    expect(state.moves).toEqual([]);
    await userEvent.click(within(confirm).getByRole('button', { name: 'Move and recompute' }));
    expect(
      await screen.findByText('Moved D main to Long-term and recomputed 7 positions.'),
    ).toBeInTheDocument();
    expect(state.moves).toEqual([{ id: 'a1', profileId: 'p2' }]);
  });

  it('a move can be cancelled', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Move…' })).toBeInTheDocument();
    expect(state.moves).toEqual([]);
  });

  it('saves the breakeven threshold and explains a bad value', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    const field = await screen.findByLabelText('New threshold (₹)');
    await userEvent.type(field, '12,5{Enter}');
    expect(
      await screen.findByText('Enter rupees with up to two decimals, for example 10 or 12.50.'),
    ).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, '12.50{Enter}');
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(state.breakeven).toBe('12500000');
    // The current value is shown through the Money formatter (spoken and visible text).
    expect((await screen.findAllByText('₹12.50')).length).toBeGreaterThan(0);
  });

  it('lists the fee-rule versions, read-only', async () => {
    renderSettings(server().routes);
    const row = await screen.findByRole('row', { name: /nse\/2024-10-01/ });
    expect(row).toHaveTextContent('Exchange and taxes');
    expect(row).toHaveTextContent('01 Oct 2024');
    expect(row).toHaveTextContent('1,234');
    expect(within(row).queryByRole('button')).toBeNull();
  });

  it('with one profile there is nowhere to move to', async () => {
    const { state, routes } = server();
    state.profiles.pop();
    renderSettings(routes);
    expect(await screen.findByText('Create another profile to move it.')).toBeInTheDocument();
  });
});

describe('settings after a move', () => {
  it('closes the confirmation and offers the profile it left as the next target', async () => {
    const { routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Move…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move and recompute' }));
    await screen.findByText('Moved D main to Long-term and recomputed 7 positions.');
    expect(screen.queryByRole('group', { name: 'Confirm moving D main' })).toBeNull();
    expect(await screen.findByLabelText('Move D main to')).toHaveDisplayValue('Swing');
  });
});
