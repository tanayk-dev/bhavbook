// S13a-1/2: the app frame, the overview and onboarding, against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

const NO_TRADES = {
  breakevenMicro: '0',
  includeIncomplete: false,
  includedIncomplete: 0,
  summary: {
    trades: 0,
    wins: 0,
    losses: 0,
    breakevens: 0,
    grossMicro: '0',
    chargesMicro: '0',
    netMicro: '0',
    estimated: false,
    winRate: null,
    expectancy: null,
    avgWinner: null,
    avgLoser: null,
    profitFactor: null,
    avgR: null,
    rTrades: 0,
    avgHoldingDays: null,
    excluded: { incomplete: 0, excluded: 0, noStop: 0 },
  },
  days: [],
  months: [],
  bySetup: [],
  byMistake: [],
  mistakeCost: [],
};
// The Overview's dashboard: an empty vault has no trades yet.
const VAULT = {
  'GET /api/vault': { body: { schemaVersion: 3 } },
  'GET /api/analytics': { body: NO_TRADES },
};
const ONE_ACCOUNT = {
  ...VAULT,
  'GET /api/profiles': {
    body: {
      profiles: [{ id: 'p1', name: 'Swing', accounts: [{ id: 'a1', broker: 'dhan', nickname: 'D main' }] }],
    },
  },
};

function renderApp(routes: Routes, path = '/') {
  const fetch = stubServer(routes);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({ routeTree, context: { queryClient }, history });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

describe('the overview', () => {
  it('shows the frame, the open vault and the accounts', async () => {
    renderApp(ONE_ACCOUNT);
    expect(await screen.findByText('Vault schema v3')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    const row = await screen.findByRole('row', { name: /D main/ });
    expect(row).toHaveTextContent('Dhan');
    expect(row).toHaveTextContent('Swing');
    expect(screen.getByRole('region', { name: 'No trades yet' })).toBeInTheDocument();
  });

  it('a profile without accounts asks for one', async () => {
    renderApp({
      ...VAULT,
      'GET /api/profiles': { body: { profiles: [{ id: 'p1', name: 'Swing', accounts: [] }] } },
    });
    expect(await screen.findByRole('region', { name: 'No broker accounts yet' })).toBeInTheDocument();
  });

  it.each([
    [401, 'This BhavBook session has ended'],
    [403, 'BhavBook does not accept this address'],
  ])('a %i explains how to get back to BhavBook', async (status, title) => {
    renderApp({
      'GET /api/vault': { status, body: { error: 'x' } },
      'GET /api/profiles': { status, body: { error: 'x' } },
    });
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });

  it('a stopped server says BhavBook is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createRouter({ routeTree, context: { queryClient }, history: createMemoryHistory() });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'BhavBook is not running' })).toBeInTheDocument();
  });

  it('a server error can be retried', async () => {
    const { fetch } = renderApp({
      ...ONE_ACCOUNT,
      'GET /api/vault': { status: 500, body: { error: 'internal_error' } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByRole('button', { name: 'Try again' });
    const vaultCalls = fetch.mock.calls.filter(([input]) =>
      (input instanceof Request ? input.url : input.toString()).endsWith('/api/vault'),
    );
    expect(vaultCalls).toHaveLength(2);
  });

  it('an unknown address says so, with a way back', async () => {
    renderApp(ONE_ACCOUNT, '/nowhere');
    expect(await screen.findByText('There is no page at this address.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Go to the overview' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('offers a skip link, and switches between the light and dark themes', async () => {
    renderApp(ONE_ACCOUNT);
    await screen.findByText('Vault schema v3');
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });
});

interface StubProfile {
  readonly id: string;
  readonly name: string;
  readonly accounts: { id: string; broker: string; nickname: string }[];
}

function onboardingServer() {
  const profiles: StubProfile[] = [];
  const routes: Routes = {
    ...VAULT,
    'GET /api/profiles': () => ({ body: { profiles } }),
    'POST /api/profiles': (body) => {
      const name = (body as { name: string }).name.trim();
      if (profiles.some((profile) => profile.name.toLowerCase() === name.toLowerCase())) {
        return { status: 409, body: { error: 'conflict' } };
      }
      const id = `p${String(profiles.length + 1)}`;
      profiles.push({ id, name, accounts: [] });
      return { status: 201, body: { id } };
    },
    'POST /api/accounts': (body) => {
      const { profileId, broker, nickname } = body as { profileId: string; broker: string; nickname: string };
      profiles.find((profile) => profile.id === profileId)?.accounts.push({ id: 'a1', broker, nickname });
      return { status: 201, body: { id: 'a1' } };
    },
  };
  return { profiles, routes };
}

describe('onboarding', () => {
  it('a new vault goes to onboarding: profile, then account, then the overview', async () => {
    const { profiles, routes } = onboardingServer();
    const { router } = renderApp(routes);
    await userEvent.type(await screen.findByLabelText('Profile name'), 'Swing');
    await userEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByRole('heading', { name: 'Add a broker account' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Dhan' }));
    await userEvent.type(screen.getByLabelText('Nickname'), 'D main');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(await screen.findByRole('row', { name: /D main/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(profiles[0]?.accounts).toEqual([{ id: 'a1', broker: 'dhan', nickname: 'D main' }]);
  });

  it('never asks for a client ID, PAN or login', async () => {
    const { routes } = onboardingServer();
    renderApp(routes, '/onboarding');
    await screen.findByLabelText('Profile name');
    expect(screen.queryByLabelText(/client|pan\b|password|login|user ?id/i)).toBeNull();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  it('explains a duplicate profile name and keeps the form', async () => {
    const { profiles, routes } = onboardingServer();
    profiles.push({ id: 'p1', name: 'Swing', accounts: [] });
    renderApp(routes, '/onboarding');
    await userEvent.click(await screen.findByRole('button', { name: 'Create another profile instead' }));
    await userEvent.type(screen.getByLabelText('Profile name'), 'swing');
    await userEvent.click(screen.getByRole('button', { name: 'Create profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You already have a profile with this name.');
    expect(screen.getByLabelText('Profile name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('with several profiles, the account goes to the one chosen', async () => {
    const { profiles, routes } = onboardingServer();
    profiles.push({ id: 'p1', name: 'Swing', accounts: [] }, { id: 'p2', name: 'Long-term', accounts: [] });
    renderApp(routes, '/onboarding');
    await userEvent.selectOptions(await screen.findByLabelText('Profile'), 'Swing');
    await userEvent.type(screen.getByLabelText('Nickname'), 'Z main');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    await screen.findByRole('row', { name: /Z main/ });
    expect(profiles[0]?.accounts).toEqual([{ id: 'a1', broker: 'zerodha', nickname: 'Z main' }]);
  });
});

describe('onboarding (review follow-ups)', () => {
  it('the redirect to onboarding replaces the history entry (no Back-button trap)', async () => {
    const { routes } = onboardingServer();
    const { router } = renderApp(routes);
    await screen.findByLabelText('Profile name');
    expect(router.state.location.pathname).toBe('/onboarding');
    expect(router.history.length).toBe(1);
  });

  it('each new step takes the keyboard focus, and a failed save returns it to the field', async () => {
    const { routes } = onboardingServer();
    renderApp(routes);
    await userEvent.type(await screen.findByLabelText('Profile name'), 'Swing{Enter}');
    expect(await screen.findByRole('heading', { name: 'Add a broker account' })).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: 'Create another profile instead' }));
    expect(await screen.findByRole('heading', { name: 'Name a profile' })).toHaveFocus();
    await userEvent.type(screen.getByLabelText('Profile name'), 'swing{Enter}');
    expect(await screen.findByText('You already have a profile with this name.')).toBeInTheDocument();
    expect(screen.getByLabelText('Profile name')).toHaveFocus();
    await userEvent.type(screen.getByLabelText('Profile name'), 'x');
    expect(screen.queryByText('You already have a profile with this name.')).toBeNull();
  });

  it('"Create another profile" has a way back, and the step line follows the form', async () => {
    const { profiles, routes } = onboardingServer();
    profiles.push({ id: 'p1', name: 'Swing', accounts: [] });
    renderApp(routes, '/onboarding');
    expect(await screen.findByText(/Step 2 of 2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Create another profile instead' }));
    expect(screen.getByText(/Step 1 of 2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Back to the account' }));
    expect(await screen.findByRole('heading', { name: 'Add a broker account' })).toHaveFocus();
  });

  it('a new profile is preselected for its first account', async () => {
    const { profiles, routes } = onboardingServer();
    profiles.push({ id: 'p1', name: 'Swing', accounts: [] });
    renderApp(routes, '/onboarding');
    await userEvent.click(await screen.findByRole('button', { name: 'Create another profile instead' }));
    await userEvent.type(screen.getByLabelText('Profile name'), 'Long-term{Enter}');
    expect(await screen.findByLabelText('Profile')).toHaveDisplayValue('Long-term');
  });

  it('explains an identifier-shaped nickname and a vanished profile', async () => {
    const { profiles, routes } = onboardingServer();
    profiles.push({ id: 'p1', name: 'Swing', accounts: [] });
    let reply = { status: 400, body: { error: 'identifier' } };
    renderApp({ ...routes, 'POST /api/accounts': () => reply }, '/onboarding');
    await userEvent.type(await screen.findByLabelText('Nickname'), 'ZM1234{Enter}');
    expect(
      await screen.findByText('That looks like a client ID or PAN. Choose a name of your own.'),
    ).toBeInTheDocument();
    reply = { status: 404, body: { error: 'not_found' } };
    await userEvent.type(screen.getByLabelText('Nickname'), '{Backspace}{Enter}');
    expect(
      await screen.findByText('That profile no longer exists. Reload the page and try again.'),
    ).toBeInTheDocument();
  });
});
