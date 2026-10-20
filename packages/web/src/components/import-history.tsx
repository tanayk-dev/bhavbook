// Import history and coverage for one account (PRD §5.1, D11). History: every committed import, newest first, with
// undo (confirm first; a backup is made, and the account is recomputed). Coverage: per report kind, the dates the
// imports cover on one shared timeline, with gaps marked in the attention colour and named in text (colour is
// never the only signal), each with where to download that period.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { focusLater, TableRegion, TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { formatIstDate, formatIstDateTime } from '@/lib/format';
import {
  importError,
  REPORTS,
  reportLabel,
  undoImport,
  type DateRange,
  type ImportRecord,
  type KindCoverage,
} from '@/lib/imports';

const rows = (count: number): string => `${count.toLocaleString('en-IN')} trade row${count === 1 ? '' : 's'}`;
const span = (range: DateRange): string =>
  range.from === range.to
    ? formatIstDate(range.from)
    : `${formatIstDate(range.from)} – ${formatIstDate(range.to)}`;

function UndoImport({
  record,
  onUndone,
}: {
  readonly record: ImportRecord;
  readonly onUndone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const start = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  const when = formatIstDateTime(record.createdAt);
  const mutation = useMutation({
    mutationFn: () => undoImport(record.id),
    onSuccess: async (removed) => {
      await queryClient.invalidateQueries();
      onUndone(`Undid the ${reportLabel(record.kind)} import from ${when}; ${rows(removed)} removed.`);
    },
    onError: () => {
      focusLater(confirm);
    },
  });
  useEffect(() => {
    if (confirming) confirm.current?.focus();
  }, [confirming]);
  if (!confirming) {
    return (
      <Button
        ref={start}
        variant="ghost"
        size="sm"
        className={TOUCH}
        aria-label={`Undo the ${reportLabel(record.kind)} import from ${when}…`}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Undo…
      </Button>
    );
  }
  const cancel = () => {
    setConfirming(false);
    mutation.reset();
    focusLater(start);
  };
  return (
    <div
      role="group"
      aria-label={`Confirm undoing the import from ${when}`}
      className="space-y-2 py-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !mutation.isPending) cancel();
      }}
    >
      <p>Remove what this import added? A backup is made first, and positions are recomputed.</p>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-loss">
          {importError(mutation.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          ref={confirm}
          size="sm"
          variant="destructive"
          className={TOUCH}
          disabled={mutation.isPending}
          onClick={() => {
            mutation.mutate();
          }}
        >
          {mutation.isPending ? 'Undoing…' : 'Undo import'}
        </Button>
        <Button variant="ghost" size="sm" className={TOUCH} disabled={mutation.isPending} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ImportHistory({
  imports,
  announce,
}: {
  readonly imports: readonly ImportRecord[];
  readonly announce: (message: string) => void;
}) {
  const region = useRef<HTMLDivElement>(null);
  const undone = (message: string) => {
    announce(message);
    focusLater(region);
  };
  return (
    <div ref={region} tabIndex={-1} className="focus-visible:outline-none">
      {imports.length === 0 ? (
        <p className="text-ink-muted">Nothing imported into this account yet.</p>
      ) : (
        <HistoryTable imports={imports} onUndone={undone} />
      )}
    </div>
  );
}

function HistoryTable({
  imports,
  onUndone,
}: {
  readonly imports: readonly ImportRecord[];
  readonly onUndone: (message: string) => void;
}) {
  return (
    <TableRegion label="Imports">
      <table className="w-full min-w-2xl border-y border-rule bg-surface text-left">
        <caption className="sr-only">Imports into this account, newest first</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              Imported
            </th>
            <th scope="col" className="px-3 font-medium">
              Report
            </th>
            <th scope="col" className="px-3 font-medium">
              Covers
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Added
            </th>
            <th scope="col" className="px-3 font-medium">
              <span className="sr-only">Undo</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {imports.map((record) => (
            <tr key={record.id} className="align-top">
              <th scope="row" className="figure px-3 py-1.5 font-normal whitespace-nowrap">
                {formatIstDateTime(record.createdAt)}
              </th>
              <td className="px-3 py-1.5">{reportLabel(record.kind)}</td>
              <td className="figure px-3 py-1.5 whitespace-nowrap">
                {record.from === null || record.to === null
                  ? '—'
                  : span({ from: record.from, to: record.to })}
              </td>
              <td className="figure px-3 py-1.5 text-right">
                {(record.counts.rows.new + record.counts.statements.new).toLocaleString('en-IN')}
              </td>
              <td className="px-3 py-0.5 text-right">
                <UndoImport record={record} onUndone={onUndone} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

const DAY_MS = 86_400_000;
const day = (date: string): number => Date.parse(`${date}T00:00:00Z`) / DAY_MS;

/** A share of the shared timeline, as a CSS percentage. */
const percent = (value: number): string => `${(value * 100).toFixed(3)}%`;

function Timeline({
  coverage,
  start,
  days,
}: {
  readonly coverage: KindCoverage;
  readonly start: number;
  readonly days: number;
}) {
  const place = (range: DateRange) => ({
    left: percent((day(range.from) - start) / days),
    width: percent((day(range.to) - day(range.from) + 1) / days),
  });
  return (
    <div aria-hidden="true" className="relative h-3 w-full rounded-sm bg-muted">
      {coverage.ranges.map((range) => (
        <div
          key={`r${range.from}`}
          className="absolute inset-y-0 min-w-0.5 rounded-sm bg-primary"
          style={place(range)}
        />
      ))}
      {coverage.gaps.map((gap) => (
        <div
          key={`g${gap.from}`}
          className="absolute inset-y-0 min-w-0.5 border-x border-attention bg-attention/30"
          style={place(gap)}
        />
      ))}
    </div>
  );
}

export function CoverageView({ coverage }: { readonly coverage: readonly KindCoverage[] }) {
  const all = coverage.flatMap((entry) => entry.ranges);
  if (all.length === 0) {
    return <p className="text-ink-muted">Coverage appears here once something is imported.</p>;
  }
  const start = Math.min(...all.map((range) => day(range.from)));
  const end = Math.max(...all.map((range) => day(range.to)));
  const days = end - start + 1;
  const date = (n: number): string => formatIstDate(new Date(n * DAY_MS).toISOString().slice(0, 10));
  return (
    <div className="space-y-3">
      <p className="figure text-sm text-ink-muted">
        Each bar runs from {date(start)} to {date(end)}. Gaps are marked and listed under their report.
      </p>
      <ul className="space-y-4">
        {coverage.map((entry) => {
          const guide = REPORTS[entry.kind];
          return (
            <li key={entry.kind} className="space-y-1.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4">
                <h3 className="text-sm font-semibold">{reportLabel(entry.kind)}</h3>
                <p className="figure text-sm text-ink-muted">{entry.ranges.map(span).join(', ')}</p>
              </div>
              <Timeline coverage={entry} start={start} days={days} />
              {entry.gaps.length === 0 ? null : (
                <div className="text-sm">
                  <p className="text-attention">
                    Not covered: {entry.gaps.map(span).join(', ')}. Weekends and holidays count here; check
                    whether you traded then.
                  </p>
                  {guide === undefined ? null : (
                    <p className="text-ink-muted">
                      To fill a gap, download that period from{' '}
                      <a
                        href={guide.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-[13px] text-primary underline-offset-4 hover:underline"
                      >
                        {guide.where}
                      </a>{' '}
                      ({guide.limit}) and import it above.
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
