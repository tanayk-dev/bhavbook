import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useId, useRef, useState } from 'react';
import { IssueCard } from '@/components/issue-card';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { issueSummaryQuery, issuesQuery, kindLabel, type IssueStatus } from '@/lib/issues';
import { profilesQuery } from '@/lib/profiles';

export const Route = createFileRoute('/issues')({ component: IssuesPage });

const ANNOUNCE_DELAY_MS = 50;
const SELECT =
  'h-11 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-9';

/** j / k move between issues, like a mail inbox; the focus lands on the issue's heading. */
function moveFocus(list: HTMLElement | null, step: 1 | -1): void {
  const headings = [...(list?.querySelectorAll<HTMLElement>('article h3') ?? [])];
  if (headings.length === 0) return;
  const at = headings.findIndex((heading) => heading.closest('article')?.contains(document.activeElement));
  const next = headings[Math.min(headings.length - 1, Math.max(0, at === -1 ? 0 : at + step))];
  next?.focus();
}

function IssuesPage() {
  const [status, setStatus] = useState<IssueStatus>('open');
  const [kind, setKind] = useState('');
  const [accountId, setAccountId] = useState('');
  const [notice, setNotice] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const ids = { status: useId(), kind: useId(), account: useId() };
  const summary = useQuery(issueSummaryQuery);
  const profiles = useQuery(profilesQuery);
  const issues = useQuery(
    issuesQuery({
      status,
      ...(kind === '' ? {} : { kind }),
      ...(accountId === '' ? {} : { accountId }),
    }),
  );
  // Cleared, then set: a repeated message is announced again.
  const announce = (message: string) => {
    window.clearTimeout(timer.current);
    setNotice('');
    timer.current = window.setTimeout(() => {
      setNotice(message);
    }, ANNOUNCE_DELAY_MS);
  };
  const disconnection = issues.error instanceof ApiError ? issues.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  const accounts = (profiles.data ?? []).flatMap((profile) => profile.accounts);
  const kinds = Object.keys(summary.data?.byKind ?? {});
  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold">Issues</h1>
        <p role="status" className="text-sm">
          {notice}
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1">
          <Label htmlFor={ids.status}>Show</Label>
          <select
            id={ids.status}
            className={SELECT}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as IssueStatus);
            }}
          >
            <option value="open">Open</option>
            <option value="dismissed">Dismissed</option>
            <option value="resolved">Resolved</option>
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids.kind}>Kind</Label>
          <select
            id={ids.kind}
            className={SELECT}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
            }}
          >
            <option value="">All kinds</option>
            {[...new Set([...kinds, ...(kind === '' ? [] : [kind])])].map((entry) => (
              <option key={entry} value={entry}>
                {kindLabel(entry)}
                {summary.data?.byKind[entry] === undefined ? '' : ` (${String(summary.data.byKind[entry])})`}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor={ids.account}>Account</Label>
          <select
            id={ids.account}
            className={SELECT}
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
            }}
          >
            <option value="">All accounts</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.nickname}
              </option>
            ))}
          </select>
        </div>
        <p className="text-sm text-ink-muted">
          Press <kbd className="font-mono">j</kbd> and <kbd className="font-mono">k</kbd> to move between
          issues.
        </p>
      </div>
      {issues.isPending ? <LoadingRows label="Loading issues" rows={4} /> : null}
      {issues.isError ? (
        <ErrorState
          message="Could not read the issues."
          retrying={issues.isFetching}
          onRetry={() => {
            void issues.refetch();
          }}
        />
      ) : null}
      {issues.isSuccess && issues.data.issues.length === 0 ? (
        <EmptyState title={status === 'open' ? 'Nothing needs your attention' : `No ${status} issues`}>
          {status === 'open' ? 'BhavBook flags anything that needs a decision here as you import.' : null}
        </EmptyState>
      ) : null}
      {issues.isSuccess && issues.data.issues.length > 0 ? (
        <section aria-label="Issues">
          {issues.data.total > issues.data.issues.length ? (
            <p className="text-sm text-ink-muted">
              Showing the newest {issues.data.issues.length} of {issues.data.total}. Narrow the list with the
              filters.
            </p>
          ) : null}
          <div
            ref={list}
            onKeyDown={(event) => {
              const target = event.target as HTMLElement;
              if (target.closest('input, select, textarea') !== null) return;
              if (event.key === 'j') moveFocus(list.current, 1);
              if (event.key === 'k') moveFocus(list.current, -1);
            }}
          >
            {issues.data.issues.map((issue) => (
              <IssueCard
                key={issue.id}
                issue={issue}
                instruments={issues.data.instruments}
                onDone={announce}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
