import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { ApiError } from '@/lib/api';
import { vaultQuery } from '@/lib/queries';

export const Route = createFileRoute('/')({ component: Overview });

function Overview() {
  const vault = useQuery(vaultQuery);
  const disconnection = vault.error instanceof ApiError ? vault.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold">Overview</h1>
        {vault.isSuccess ? (
          <p className="figure text-ink-muted">Vault schema v{vault.data.schemaVersion}</p>
        ) : null}
      </div>
      {vault.isPending ? <LoadingRows label="Loading the vault" rows={3} /> : null}
      {vault.isError ? (
        <ErrorState
          message="Could not read the vault."
          retrying={vault.isFetching}
          onRetry={() => void vault.refetch()}
        />
      ) : null}
      {vault.isSuccess ? (
        <EmptyState title="No trades yet">
          Import a Zerodha tradebook or a Dhan trade history to rebuild your positions. The import wizard
          arrives in a later step of this pre-alpha build.
        </EmptyState>
      ) : null}
    </div>
  );
}
