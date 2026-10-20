// Entry point. The launch token is stripped from the URL before anything renders (ADR-0002); fonts ship in the
// bundle (no runtime fetch, PRD §12); the theme preference is applied before the first paint.
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiError } from '@/lib/api';
import { stripLaunchToken } from '@/lib/session';
import { applyTheme, safeStorage, storedTheme } from '@/lib/theme';
import { routeTree } from './routeTree.gen';

stripLaunchToken(window.location, window.history);
applyTheme(storedTheme(safeStorage()), document.documentElement, safeStorage());

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A rejected session never succeeds on retry; anything else is retried once (the server is local).
      retry: (failures, error) => !(error instanceof ApiError && error.sessionEnded) && failures < 1,
      refetchOnWindowFocus: false,
    },
  },
});

const router = createRouter({ routeTree, context: { queryClient }, defaultPreload: 'intent' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
