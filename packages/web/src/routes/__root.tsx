import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { AppFrame } from '@/components/app-frame';
import { Disconnected, ErrorState } from '@/components/states';
import { ApiError } from '@/lib/api';

export interface RouterContext {
  readonly queryClient: QueryClient;
}

function NotFound() {
  return (
    <>
      <h1 className="mb-4 text-lg font-semibold">Page not found</h1>
      <ErrorState message="There is no page at this address.">
        <Link to="/" className="mt-3 inline-block text-primary underline-offset-4 hover:underline">
          Go to the overview
        </Link>
      </ErrorState>
    </>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame>
      <Outlet />
    </AppFrame>
  ),
  errorComponent: ({ error, reset }) => {
    const disconnection = error instanceof ApiError ? error.disconnection : null;
    return (
      <AppFrame>
        {disconnection === null ? (
          <ErrorState message="Something went wrong loading this page." onRetry={reset} />
        ) : (
          <Disconnected reason={disconnection} />
        )}
      </AppFrame>
    );
  },
  notFoundComponent: NotFound,
});
