// S13a-1/2: the app frame, the overview and onboarding, against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

const VAULT = { 'GET /api/vault': { body: { schemaVersion: 3 } } };
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
