// The Overview (PRD §4; plan S15b): the dashboard for the filters in the URL (so a view can be bookmarked), then the
// accounts. Before any trade is imported it says so and links to the import.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, Navigate } from '@tanstack/react-router';
import { Dashboard, FilterBar } from '@/components/dashboard';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { buttonVariants } from '@/components/ui/button';
import { analyticsQuery, dashboardFilterOf } from '@/lib/analytics';
import { ApiError } from '@/lib/api';
import { BROKERS, profilesQuery, type Profile } from '@/lib/profiles';
import { vaultQuery } from '@/lib/queries';

export const Route = createFileRoute('/')({ validateSearch: dashboardFilterOf, component: Overview });

const brokerLabel = (id: string): string => BROKERS.find((broker) => broker.id === id)?.label ?? id;

function Accounts({ profiles }: { readonly profiles: readonly Profile[] }) {
  const rows = profiles.flatMap((profile) => profile.accounts.map((account) => ({ profile, account })));
  return (
    <section aria-labelledby="accounts-title" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="accounts-title" className="text-base font-semibold">
          Accounts
        </h2>
        <Link to="/onboarding" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          Add a broker account
        </Link>
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No broker accounts yet">
          Add the Zerodha or Dhan account you trade from.
        </EmptyState>
      ) : (
        <table className="w-full border-y border-rule bg-surface text-left">
          <thead className="text-ink-muted">
            <tr className="h-8 border-b border-rule">
              <th scope="col" className="px-3 font-medium">
                Account
              </th>
              <th scope="col" className="px-3 font-medium">
                Broker
              </th>
              <th scope="col" className="px-3 font-medium">
                Profile
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rows.map(({ profile, account }) => (
              <tr key={account.id} className="h-8">
                <td className="px-3">{account.nickname}</td>
                <td className="px-3">{brokerLabel(account.broker)}</td>
                <td className="px-3 text-ink-muted">{profile.name}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Overview() {
  const filter = Route.useSearch();
  const navigate = Route.useNavigate();
  const vault = useQuery(vaultQuery);
  const profiles = useQuery(profilesQuery);
  // The last view stays (dimmed) while a new filter loads, so the page does not blank on every change.
  const analytics = useQuery({ ...analyticsQuery(filter), placeholderData: keepPreviousData });
  const failure = vault.error ?? profiles.error;
  const disconnection = failure instanceof ApiError ? failure.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  if (profiles.isSuccess && profiles.data.length === 0) return <Navigate to="/onboarding" replace />;
  const filtered = Object.keys(filter).length > 0;
  const nothingYet =
    analytics.isSuccess &&
    !filtered &&
    analytics.data.summary.trades === 0 &&
    analytics.data.days.length === 0;
  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-lg font-semibold">Overview</h1>
        {vault.isSuccess ? (
          <p className="figure text-ink-muted">Vault schema v{vault.data.schemaVersion}</p>
        ) : null}
      </div>
      {vault.isPending || profiles.isPending ? <LoadingRows label="Loading the vault" rows={3} /> : null}
      {failure === null ? null : (
        <ErrorState
          message="Could not read the vault."
          retrying={vault.isFetching || profiles.isFetching}
          onRetry={() => {
            void vault.refetch();
            void profiles.refetch();
          }}
        />
      )}
      {profiles.isSuccess && !nothingYet ? (
        <FilterBar
          filter={filter}
          profiles={profiles.data}
          onChange={(next) => {
            void navigate({ search: next, replace: true });
          }}
        />
      ) : null}
      {analytics.isPending ? <LoadingRows label="Working out the numbers" rows={4} /> : null}
      {analytics.isError ? (
        <ErrorState
          message="Could not work out the numbers."
          retrying={analytics.isFetching}
          onRetry={() => {
            void analytics.refetch();
          }}
        />
      ) : null}
      {nothingYet ? (
        <EmptyState title="No trades yet">
          <Link to="/import" className="text-primary underline-offset-4 hover:underline">
            Import a Zerodha tradebook or a Dhan trade history
          </Link>{' '}
          to rebuild your positions.
        </EmptyState>
      ) : null}
      {analytics.isSuccess && !nothingYet ? (
        <div
          aria-busy={analytics.isPlaceholderData}
          className={analytics.isPlaceholderData ? 'opacity-60' : undefined}
        >
          <Dashboard analytics={analytics.data} />
        </div>
      ) : null}
      {vault.isSuccess && profiles.isSuccess ? <Accounts profiles={profiles.data} /> : null}
    </div>
  );
}
