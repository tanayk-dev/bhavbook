// S13a-3b-1: tags on the settings page against a stubbed server, through the real router.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api';
import { tags } from '@/lib/tags';
import { routeTree } from '@/routeTree.gen';
import { stubServer, type Routes } from './server';

interface StubTag {
  id: string;
  kind: 'setup' | 'mistake';
  name: string;
  uses: number;
}

function server() {
  const state = {
    tags: [
      { id: 't1', kind: 'setup', name: 'Breakout', uses: 3 },
      { id: 't2', kind: 'setup', name: 'BO', uses: 2 },
      { id: 't3', kind: 'mistake', name: 'FOMO', uses: 1 },
    ] as StubTag[],
    calls: [] as string[],
  };
  const routes: Routes = {
    'GET /api/profiles': { body: { profiles: [{ id: 'p1', name: 'Swing', accounts: [] }] } },
    'GET /api/settings': { body: { breakevenThresholdMicro: '0', feeRules: [] } },
    'GET /api/tags': () => ({ body: { tags: state.tags } }),
    'GET /api/vault/backups': { body: { backups: [] } },
    'POST /api/tags': (body) => {
      const { kind, name } = body as { kind: 'setup' | 'mistake'; name: string };
      state.calls.push(`create ${kind} ${name}`);
      if (state.tags.some((tag) => tag.kind === kind && tag.name.toLowerCase() === name.toLowerCase())) {
        return { status: 409, body: { error: 'conflict' } };
      }
      state.tags.push({ id: `t${String(state.tags.length + 1)}`, kind, name, uses: 0 });
      return { status: 201, body: { id: 'new' } };
    },
    'POST /api/tags/t2/merge': (body) => {
      state.calls.push(`merge t2 ${(body as { intoId: string }).intoId}`);
      state.tags = state.tags.filter((tag) => tag.id !== 't2');
      return { body: { merged: 2 } };
    },
    'DELETE /api/tags/t3': () => {
      state.calls.push('delete t3');
      state.tags = state.tags.filter((tag) => tag.id !== 't3');
      return { body: { detached: 1 } };
    },
    'PATCH /api/tags/t1': (body) => {
      state.calls.push(`rename t1 ${(body as { name: string }).name}`);
      return { body: { ok: true } };
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

describe('reading tags', () => {
  it('accepts the server shape and refuses anything else', () => {
    expect(tags({ tags: [{ id: 't', kind: 'setup', name: 'A', uses: 0 }] })).toHaveLength(1);
    for (const body of [
      null,
      { tags: 'x' },
      { tags: [{ id: 't', kind: 'habit', name: 'A', uses: 0 }] },
      { tags: [{ id: 't', kind: 'setup', name: 'A', uses: -1 }] },
      { tags: [{ id: 't', kind: 'setup', name: 'A', uses: 1.5 }] },
    ]) {
      expect(() => tags(body)).toThrow(ApiError);
    }
  });
});

describe('tags in settings', () => {
  it('lists each kind with how many journal entries use each tag', async () => {
    renderSettings(server().routes);
    const setups = await screen.findByRole('region', { name: 'Setup tags' });
    expect(within(setups).getByRole('row', { name: /^Breakout/ })).toHaveTextContent('3');
    expect(within(screen.getByRole('region', { name: 'Mistake tags' })).getAllByRole('row')).toHaveLength(2);
  });

  it('adds a tag, and says so when the name is taken', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    const field = await screen.findByLabelText('New mistake tag');
    await userEvent.type(field, 'Moved stop{Enter}');
    expect(await screen.findByText('Added the mistake tag Moved stop.')).toBeInTheDocument();
    expect(field).toHaveValue('');
    await userEvent.type(field, 'fomo{Enter}');
    expect(
      await screen.findByText('You already have a tag of this kind with this name.'),
    ).toBeInTheDocument();
    expect(field).toHaveFocus();
    expect(state.calls).toEqual(['create mistake Moved stop', 'create mistake fomo']);
  });

  it('merges after confirming, into the chosen tag of the same kind', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Merge BO…' }));
    const confirm = screen.getByRole('group', { name: 'Confirm merging BO' });
    expect(confirm).toHaveTextContent(
      'Merge BO into Breakout? Breakout replaces it on 2 journal entries, and BO is deleted.',
    );
    expect(within(confirm).getByRole('button', { name: 'Merge' })).toHaveFocus();
    await userEvent.click(within(confirm).getByRole('button', { name: 'Merge' }));
    expect(
      await screen.findByText('Merged BO into Breakout; it was on 2 journal entries.'),
    ).toBeInTheDocument();
    expect(state.calls).toEqual(['merge t2 t1']);
    await waitFor(() => {
      expect(screen.getByLabelText('New setup tag')).toHaveFocus();
    });
    // The only mistake tag has nothing to merge into.
    expect(screen.queryByRole('button', { name: 'Merge FOMO…' })).toBeNull();
  });

  it('deletes after confirming, saying the entries are kept; cancel changes nothing', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Delete FOMO…' }));
    expect(screen.getByRole('button', { name: 'Delete tag' })).toHaveAccessibleDescription(
      'Delete FOMO? It is removed from 1 journal entry; the entries themselves are kept.',
    );
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete FOMO…' })).toHaveFocus();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Delete FOMO…' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Delete FOMO…' })).toHaveFocus();
    });
    expect(state.calls).toEqual([]);

    await userEvent.click(screen.getByRole('button', { name: 'Delete FOMO…' }));
    const confirm = screen.getByRole('group', { name: 'Confirm deleting FOMO' });
    expect(confirm).toHaveTextContent(
      'Delete FOMO? It is removed from 1 journal entry; the entries themselves are kept.',
    );
    await userEvent.click(within(confirm).getByRole('button', { name: 'Delete tag' }));
    expect(await screen.findByText('Deleted FOMO and removed it from 1 journal entry.')).toBeInTheDocument();
    expect(await screen.findByText('No mistake tags yet.')).toBeInTheDocument();
    expect(state.calls).toEqual(['delete t3']);
  });

  it('renames a tag inline', async () => {
    const { state, routes } = server();
    renderSettings(routes);
    await userEvent.click(await screen.findByRole('button', { name: 'Rename Breakout' }));
    const field = screen.getByLabelText('New setup tag name');
    await userEvent.clear(field);
    await userEvent.type(field, 'Range breakout{Enter}');
    expect(await screen.findByText('Renamed the tag to Range breakout.')).toBeInTheDocument();
    expect(state.calls).toEqual(['rename t1 Range breakout']);
  });
});
