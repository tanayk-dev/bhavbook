import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { AppFrame } from '@/components/app-frame';
import { ErrorState, SessionEnded } from '@/components/states';
import { ApiError } from '@/lib/api';

export interface RouterContext {
  readonly queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <AppFrame>
      <Outlet />
    </AppFrame>
  ),
  errorComponent: ({ error, reset }) =>
    error instanceof ApiError && error.sessionEnded ? (
      <SessionEnded />
    ) : (
      <AppFrame>
        <ErrorState message="Something went wrong loading this page." onRetry={reset} />
      </AppFrame>
    ),
  notFoundComponent: () => <ErrorState message="There is no page at this address." />,
});
