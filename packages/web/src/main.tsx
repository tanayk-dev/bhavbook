// Entry point. The launch token is stripped from the URL before anything renders (ADR-0002); fonts ship in the
// bundle (no runtime fetch, PRD §12); the saved theme was applied by public/theme-init.js before the first paint.
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { shouldRetry } from '@/lib/api';
import { stripLaunchToken } from '@/lib/session';
import { routeTree } from './routeTree.gen';

/** The server is local: a retry that can succeed is worth trying quickly. */
const RETRY_DELAY_MS = 300;

stripLaunchToken(window.location, window.history);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: shouldRetry, retryDelay: RETRY_DELAY_MS, refetchOnWindowFocus: false },
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
