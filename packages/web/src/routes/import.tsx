import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useId, useRef, useState, type ReactNode } from 'react';
import { CoverageView, ImportHistory } from '@/components/import-history';
import { ImportWizard } from '@/components/import-wizard';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { coverageQuery, importsQuery } from '@/lib/imports';
import { BROKERS, profilesQuery, type Account } from '@/lib/profiles';

export const Route = createFileRoute('/import')({ component: ImportPage });

const brokerLabel = (id: string): string => BROKERS.find((broker) => broker.id === id)?.label ?? id;
const ANNOUNCE_DELAY_MS = 50;

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** History and coverage for the chosen account. */
function AccountRecords({
  accountId,
  announce,
}: {
  readonly accountId: string;
  readonly announce: (message: string) => void;
}) {
  const imports = useQuery(importsQuery(accountId));
  const coverage = useQuery(coverageQuery(accountId));
  const failure = imports.error ?? coverage.error;
  if (failure !== null) {
    return (
      <ErrorState
        message="Could not read this account's imports."
        retrying={imports.isFetching || coverage.isFetching}
        onRetry={() => {
          void imports.refetch();
          void coverage.refetch();
        }}
      />
    );
  }
  if (!imports.isSuccess || !coverage.isSuccess) return <LoadingRows label="Loading imports" rows={3} />;
  return (
    <>
      <Section id="coverage-title" title="Coverage">
        <CoverageView coverage={coverage.data} />
      </Section>
      <Section id="history-title" title="Import history">
        <ImportHistory imports={imports.data} announce={announce} />
      </Section>
    </>
  );
}

interface Choice {
  readonly account: Account;
  readonly profileName: string;
}

function ImportPage() {
  const profiles = useQuery(profilesQuery);
  const [chosenId, setChosenId] = useState<string>();
  const [notice, setNotice] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const fieldId = useId();
  // Cleared, then set: a repeated message is announced again.
  const announce = (message: string) => {
    window.clearTimeout(timer.current);
    setNotice('');
    timer.current = window.setTimeout(() => {
      setNotice(message);
    }, ANNOUNCE_DELAY_MS);
  };
  const disconnection = profiles.error instanceof ApiError ? profiles.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  const choices: Choice[] = (profiles.data ?? []).flatMap((profile) =>
    profile.accounts.map((account) => ({ account, profileName: profile.name })),
  );
  const chosen = choices.find((choice) => choice.account.id === chosenId) ?? choices[0];
  return (
    <div className="max-w-5xl space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold">Import</h1>
        <p role="status" className="text-sm">
          {notice}
        </p>
      </div>
      {profiles.isPending ? <LoadingRows label="Loading accounts" rows={2} /> : null}
      {profiles.isError ? (
        <ErrorState
          message="Could not read your accounts."
          retrying={profiles.isFetching}
          onRetry={() => {
            void profiles.refetch();
          }}
        />
      ) : null}
      {profiles.isSuccess && chosen === undefined ? (
        <EmptyState title="No broker accounts yet">
          <Link to="/onboarding" className="text-primary underline-offset-4 hover:underline">
            Add the Zerodha or Dhan account
          </Link>{' '}
          the files belong to first.
        </EmptyState>
      ) : null}
      {chosen === undefined ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={fieldId}>Import into</Label>
            <select
              id={fieldId}
              value={chosen.account.id}
              className="h-11 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-9"
              onChange={(event) => {
                setChosenId(event.target.value);
              }}
            >
              {choices.map(({ account, profileName }) => (
                <option key={account.id} value={account.id}>
                  {account.nickname} ({brokerLabel(account.broker)}, {profileName})
                </option>
              ))}
            </select>
          </div>
          <ImportWizard key={chosen.account.id} account={chosen.account} announce={announce} />
          <AccountRecords accountId={chosen.account.id} announce={announce} />
        </>
      )}
    </div>
  );
}
