import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { EmptyState, ErrorState, LoadingRows, SessionEnded } from '@/components/states';
import { ApiError } from '@/lib/api';
import { vaultQuery } from '@/lib/queries';

export const Route = createFileRoute('/')({ component: Overview });

export function Overview() {
  const vault = useQuery(vaultQuery);
  if (vault.isPending) return <LoadingRows label="Loading the vault" rows={3} />;
  if (vault.isError) {
    if (vault.error instanceof ApiError && vault.error.sessionEnded) return <SessionEnded />;
    return <ErrorState message="Could not read the vault." onRetry={() => void vault.refetch()} />;
  }
  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="figure text-ink-muted">Vault schema v{vault.data.schemaVersion}</p>
      </div>
      <EmptyState title="No trades yet">
        Import a Zerodha tradebook or a Dhan trade history to rebuild your positions. The import wizard
        arrives in a later step of this pre-alpha build.
      </EmptyState>
    </div>
  );
}
