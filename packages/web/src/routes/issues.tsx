import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import { IssueCard } from '@/components/issue-card';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { issueSummaryQuery, issuesQuery, KIND_LABELS, kindLabel, type IssueStatus } from '@/lib/issues';
import { profilesQuery } from '@/lib/profiles';

export const Route = createFileRoute('/issues')({ component: IssuesPage });

const ANNOUNCE_DELAY_MS = 50;
const SELECT =
  'h-11 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-9';

const headingsIn = (list: HTMLElement | null): HTMLElement[] => [
  ...(list?.querySelectorAll<HTMLElement>('article h2') ?? []),
];

/** j / k move between issues, like a mail inbox; the focus lands on the issue's heading. */
function moveFocus(list: HTMLElement | null, step: 1 | -1): void {
  const headings = headingsIn(list);
  const at = headings.findIndex((heading) => heading.closest('article')?.contains(document.activeElement));
  const next = at === -1 ? headings[0] : headings[Math.min(headings.length - 1, Math.max(0, at + step))];
  next?.focus();
}

function IssuesPage() {
  const [status, setStatus] = useState<IssueStatus>('open');
  const [kind, setKind] = useState('');
  const [accountId, setAccountId] = useState('');
  const [notice, setNotice] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const list = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  // The issue whose action ran: if the refetch removed its card, focus moves to the issue after it (or the title).
  const acted = useRef<{ index: number } | null>(null);
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
  // After a refetch that removed the card that had focus, keep the keyboard user in the list.
  useEffect(() => {
    if (acted.current === null || !issues.isSuccess) return;
    if (list.current?.contains(document.activeElement) === true) return;
    const headings = headingsIn(list.current);
    const next = headings[Math.min(acted.current.index, headings.length - 1)] ?? title.current;
    acted.current = null;
    next?.focus();
  }, [issues.data, issues.isSuccess]);
  const remember = (issueId: string) => {
    const index = issues.data?.issues.findIndex((issue) => issue.id === issueId) ?? -1;
    acted.current = index === -1 ? null : { index };
  };
  const disconnection = issues.error instanceof ApiError ? issues.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  const accounts = (profiles.data ?? []).flatMap((profile) => profile.accounts);
  // Counts are of open issues; the other views list every kind.
  const counts = status === 'open' ? (summary.data?.byKind ?? {}) : {};
  const kinds = status === 'open' ? Object.keys(counts) : Object.keys(KIND_LABELS);
  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 ref={title} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          Issues
        </h1>
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
                {counts[entry] === undefined ? '' : ` (${String(counts[entry])})`}
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
          In the list, <kbd className="font-mono">j</kbd> and <kbd className="font-mono">k</kbd> move between
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
              if (event.ctrlKey || event.metaKey || event.altKey) return;
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
                onDone={(message) => {
                  remember(issue.id);
                  announce(message);
                }}
                onFailed={(message) => {
                  remember(issue.id);
                  announce(`Could not do that: ${message}`);
                }}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
