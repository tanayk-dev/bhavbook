// The review queue (PRD §4, §5.3; plan S14a): closed positions not yet reviewed, newest first, for the weekly
// ritual. Keyboard first: j / k move between positions, r marks the one in focus reviewed (or reopens it on the
// Reviewed tab), Enter opens it. Amounts go through Money, dates are IST.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Money } from '@/components/money';
import { TableRegion, TOUCH } from '@/components/settings';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { formatIstDate, istDateOf } from '@/lib/format';
import {
  reviewError,
  reviewQueueQuery,
  setReviewed,
  type PositionSummary,
  type ReviewFilter,
} from '@/lib/positions';

export const Route = createFileRoute('/review')({ component: ReviewPage });

const ANNOUNCE_DELAY_MS = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

const rowLinks = (table: HTMLElement | null): HTMLElement[] => [
  ...(table?.querySelectorAll<HTMLElement>('a[data-position]') ?? []),
];

/** Calendar days held, by IST date (a same-day trade is 0). */
export function daysHeld(position: PositionSummary): number {
  const opened = Date.parse(istDateOf(position.openedAtUtc));
  const closed = Date.parse(istDateOf(position.closedAtUtc ?? position.openedAtUtc));
  return Math.max(0, Math.round((closed - opened) / DAY_MS));
}

function ReviewPage() {
  const [tab, setTab] = useState<ReviewFilter>('unreviewed');
  const [notice, setNotice] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const table = useRef<HTMLTableElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  /** Where focus was when a row left the list: the row now in its place takes it. */
  const left = useRef<number | null>(null);
  const queryClient = useQueryClient();
  const queue = useQuery(reviewQueueQuery(tab));
  const announce = (message: string) => {
    window.clearTimeout(timer.current);
    setNotice('');
    timer.current = window.setTimeout(() => {
      setNotice(message);
    }, ANNOUNCE_DELAY_MS);
  };
  const toggle = useMutation({
    mutationFn: ({ position }: { position: PositionSummary; index: number }) =>
      setReviewed(position.ref, tab === 'unreviewed'),
    onSuccess: async (_result, { index }) => {
      left.current = index;
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      announce(tab === 'unreviewed' ? 'Marked reviewed.' : 'Back in the review queue.');
    },
    onError: async (error) => {
      announce(reviewError(error));
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
    },
  });
  useEffect(() => {
    if (left.current === null || !queue.isSuccess) return;
    const links = rowLinks(table.current);
    const next = links[Math.min(left.current, links.length - 1)] ?? title.current;
    left.current = null;
    next?.focus();
  }, [queue.data, queue.isSuccess]);

  const disconnection = queue.error instanceof ApiError ? queue.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  const positions = queue.data?.positions ?? [];
  const name = (key: string) => queue.data?.instruments[key] ?? key;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const links = rowLinks(table.current);
    const at = links.findIndex((link) => link === document.activeElement);
    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      const step = event.key === 'j' ? 1 : -1;
      links[at === -1 ? 0 : Math.min(links.length - 1, Math.max(0, at + step))]?.focus();
    } else if (event.key === 'r' && at !== -1 && !toggle.isPending) {
      const position = positions[at];
      if (position !== undefined) toggle.mutate({ position, index: at });
    }
  };

  return (
    <div className="max-w-5xl space-y-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 ref={title} tabIndex={-1} className="text-lg font-semibold focus:outline-none">
          Review
        </h1>
        <p role="status" className="text-sm">
          {notice}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <div role="group" aria-label="Show" className="flex gap-1">
          {(['unreviewed', 'reviewed'] as const).map((value) => (
            <Button
              key={value}
              variant={tab === value ? 'secondary' : 'ghost'}
              className={TOUCH}
              aria-pressed={tab === value}
              onClick={() => {
                setTab(value);
              }}
            >
              {value === 'unreviewed' ? 'To review' : 'Reviewed'}
            </Button>
          ))}
        </div>
        <p className="text-sm text-ink-muted">
          In the list, <kbd className="font-mono">j</kbd> / <kbd className="font-mono">k</kbd> move,{' '}
          <kbd className="font-mono">r</kbd> {tab === 'unreviewed' ? 'marks reviewed' : 'reopens'},{' '}
          <kbd className="font-mono">Enter</kbd> opens.
        </p>
      </div>
      {queue.isPending ? <LoadingRows label="Loading positions" rows={5} /> : null}
      {queue.isError ? (
        <ErrorState
          message="Could not read the positions."
          retrying={queue.isFetching}
          onRetry={() => {
            void queue.refetch();
          }}
        />
      ) : null}
      {queue.isSuccess && positions.length === 0 ? (
        <EmptyState title={tab === 'unreviewed' ? 'Nothing to review' : 'No reviewed positions yet'}>
          {tab === 'unreviewed'
            ? 'Closed positions land here as you import trades. Incomplete and excluded ones wait in Issues first.'
            : null}
        </EmptyState>
      ) : null}
      {positions.length > 0 ? (
        <TableRegion label={tab === 'unreviewed' ? 'Positions to review' : 'Reviewed positions'}>
          <table
            ref={table}
            onKeyDown={onKeyDown}
            className="w-full min-w-xl border-y border-rule bg-surface text-sm"
          >
            <caption className="sr-only">
              {tab === 'unreviewed' ? 'Closed positions to review, newest first' : 'Reviewed positions'}
            </caption>
            <thead className="text-left text-ink-muted">
              <tr className="h-8 border-b border-rule">
                <th scope="col" className="px-3 font-medium">
                  Position
                </th>
                <th scope="col" className="px-3 font-medium">
                  Closed
                </th>
                <th scope="col" className="px-3 text-right font-medium">
                  Held
                </th>
                <th scope="col" className="px-3 text-right font-medium">
                  Net P&amp;L
                </th>
                <th scope="col" className="px-3">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {positions.map((position, index) => (
                <tr key={position.ref} className="h-11 focus-within:bg-muted">
                  <th scope="row" className="px-3 text-left font-normal">
                    <Link
                      to="/positions/$ref"
                      params={{ ref: position.ref }}
                      data-position=""
                      className="rounded-sm font-medium underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {name(position.instrumentKey)}
                    </Link>
                    <span className="ml-2 text-ink-muted">
                      {position.accountNickname} · {position.bucket.toLowerCase()}
                    </span>
                  </th>
                  <td className="figure px-3">
                    {position.closedAtUtc === null ? '' : formatIstDate(istDateOf(position.closedAtUtc))}
                  </td>
                  <td className="figure px-3 text-right">
                    {daysHeld(position).toLocaleString('en-IN')} {daysHeld(position) === 1 ? 'day' : 'days'}
                  </td>
                  <td className="px-3 text-right">
                    <Money valueMicro={position.realisedGrossMicro - position.chargesMicro} signed />
                  </td>
                  <td className="px-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${tab === 'unreviewed' ? 'Mark reviewed' : 'Reopen'} ${name(position.instrumentKey)}`}
                      disabled={toggle.isPending}
                      onClick={() => {
                        toggle.mutate({ position, index });
                      }}
                    >
                      {tab === 'unreviewed' ? 'Mark reviewed' : 'Reopen'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      ) : null}
      {queue.isSuccess && queue.data.total > positions.length ? (
        <p className="text-sm text-ink-muted">
          Showing the newest {positions.length.toLocaleString('en-IN')} of{' '}
          {queue.data.total.toLocaleString('en-IN')}.
        </p>
      ) : null}
    </div>
  );
}
