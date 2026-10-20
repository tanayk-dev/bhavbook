// S13a-1: the app frame and the overview route, against a stubbed server (fetch), through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeTree } from '@/routeTree.gen';

function renderApp(path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function serve(status: number, body: unknown) {
  const fetch = vi.fn(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.classList.remove('dark');
});

describe('the app', () => {
  it('shows the frame, the open vault and the empty state', async () => {
    const fetch = serve(200, { schemaVersion: 3 });
    renderApp();
    expect(await screen.findByText('Vault schema v3')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'No trades yet' })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/api\/vault$/), expect.anything());
  });

  it.each([
    [401, 'This BhavBook session has ended'],
    [403, 'BhavBook does not accept this address'],
  ])('a %i explains how to get back to BhavBook', async (status, title) => {
    serve(status, { error: status === 401 ? 'unauthorized' : 'forbidden' });
    renderApp();
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  });

  it('a stopped server says BhavBook is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    renderApp();
    expect(await screen.findByRole('heading', { name: 'BhavBook is not running' })).toBeInTheDocument();
  });

  it('a server error can be retried', async () => {
    const fetch = serve(500, { error: 'internal_error' });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('an unknown address says so', async () => {
    serve(200, { schemaVersion: 3 });
    renderApp('/nowhere');
    expect(await screen.findByText('There is no page at this address.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('link', { name: 'Go to the overview' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
  });

  it('offers a skip link to the content', async () => {
    serve(200, { schemaVersion: 3 });
    renderApp();
    await screen.findByText('Vault schema v3');
    await userEvent.tab();
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveFocus();
  });

  it('switches between the light and dark themes', async () => {
    serve(200, { schemaVersion: 3 });
    renderApp();
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to dark theme' }));
    expect(document.documentElement).toHaveClass('dark');
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(document.documentElement).not.toHaveClass('dark');
  });
});
