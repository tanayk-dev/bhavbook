// The content states every surface implements (direction §6): loading keeps the layout and announces itself,
// empty says why and what next, errors show a fixed message with a way to retry, and a session that cannot reach
// BhavBook explains how to get back (there are no logins to offer).
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function LoadingRows({ rows = 6, label }: { readonly rows?: number; readonly label: string }) {
  return (
    <div role="status" aria-busy="true" className="divide-y divide-rule">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className="flex h-8 items-center px-3">
          <div className="h-3 w-full max-w-md animate-pulse rounded-sm bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { readonly title: string; readonly children?: ReactNode }) {
  return (
    <section aria-label={title} className="border-y border-rule bg-surface px-6 py-10">
      <h2 className="text-base font-semibold">{title}</h2>
      {children === undefined ? null : <div className="mt-2 max-w-prose text-ink-muted">{children}</div>}
    </section>
  );
}

export interface ErrorStateProps {
  readonly message: string;
  readonly onRetry?: () => void;
  /** True while a retry is in flight: the button says so and can't be pressed twice. */
  readonly retrying?: boolean;
  readonly children?: ReactNode;
}

export function ErrorState({ message, onRetry, retrying = false, children }: ErrorStateProps) {
  return (
    <section role="alert" className="border-y border-rule bg-surface px-6 py-6">
      <p className="font-medium">{message}</p>
      {children}
      {onRetry === undefined ? null : (
        <Button variant="outline" size="sm" className="mt-3" disabled={retrying} onClick={onRetry}>
          {retrying ? 'Trying again…' : 'Try again'}
        </Button>
      )}
    </section>
  );
}

/** Why the page cannot talk to BhavBook (from ApiError.reason). */
export type Disconnection = 'ended' | 'refused' | 'stopped';

const DISCONNECTED: Readonly<Record<Disconnection, { title: string; body: string }>> = {
  ended: {
    title: 'This BhavBook session has ended',
    body: 'BhavBook only answers the browser tab it opened. Start it again from your terminal:',
  },
  refused: {
    title: 'BhavBook does not accept this address',
    body: 'Open BhavBook from the link it printed in your terminal, or start it again:',
  },
  stopped: {
    title: 'BhavBook is not running',
    body: 'The BhavBook process has stopped. Start it again from your terminal:',
  },
};

export function Disconnected({ reason }: { readonly reason: Disconnection }) {
  const { title, body } = DISCONNECTED[reason];
  return (
    <section role="alert" className="mx-auto mt-24 max-w-lg border-y border-rule bg-surface px-6 py-8">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="mt-2 text-ink-muted">{body}</p>
      <pre className="mt-3 rounded-sm bg-muted px-3 py-2 font-mono text-[13px]">npx bhavbook</pre>
    </section>
  );
}
