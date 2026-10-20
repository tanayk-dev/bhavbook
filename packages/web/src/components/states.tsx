// The content states every surface implements (direction §6): loading keeps the layout, empty says why and what
// next, errors show a fixed message with a way to retry, and an ended session explains how to restart.
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';

export function LoadingRows({ rows = 6, label }: { readonly rows?: number; readonly label: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={label} className="divide-y divide-rule">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex h-8 items-center px-3">
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

export function ErrorState({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <section role="alert" className="border-y border-rule bg-surface px-6 py-6">
      <p className="font-medium">{message}</p>
      {onRetry === undefined ? null : (
        <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      )}
    </section>
  );
}

export function SessionEnded() {
  return (
    <section role="alert" className="mx-auto mt-24 max-w-lg border-y border-rule bg-surface px-6 py-8">
      <h1 className="text-lg font-semibold">This BhavBook session has ended</h1>
      <p className="mt-2 text-ink-muted">
        BhavBook only answers the browser tab it opened. Start it again from your terminal:
      </p>
      <pre className="mt-3 rounded-sm bg-muted px-3 py-2 font-mono text-[13px]">npx bhavbook</pre>
    </section>
  );
}
