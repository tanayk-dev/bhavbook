// One inbox issue (PRD §4): what it means in plain words, and its fixes. Every fix is the user's choice and is
// recomputed on the server (ADR-0013); dismissing is "I know, leave it". Amounts go through Money (formatINR), dates
// are IST, and nothing relies on colour alone.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { MapInstrumentForm, OpeningLotForm } from '@/components/issue-fixes';
import { Money } from '@/components/money';
import { TableRegion, TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { formatIstDate } from '@/lib/format';
import {
  actionError,
  addAdjustment,
  feeDiscrepancy,
  fifoMismatch,
  incompletePosition,
  issueAction,
  kindLabel,
  lotSuggestion,
  subjectInstrument,
  unresolvedInstrument,
  type Issue,
} from '@/lib/issues';

const plural = (count: bigint, one: string, many = `${one}s`): string =>
  `${count.toLocaleString('en-IN')} ${count === 1n ? one : many}`;

const COMPONENTS: Readonly<Record<string, string>> = {
  brokerage: 'Brokerage',
  stt: 'STT',
  exchange_txn: 'Exchange charges',
  sebi: 'SEBI fee',
  ipft: 'IPFT',
  stamp_duty: 'Stamp duty',
  gst: 'GST',
};

const GENERIC: Readonly<Record<string, string>> = {
  corporate_action_suspected:
    'The trades look like a split, bonus or other corporate action that has not been entered. Enter it under corporate actions (coming in a later step), or dismiss this if it is wrong.',
  cash_in_lieu: 'A corporate action left a fraction of a share, which the broker pays out as cash.',
  journal_unattached:
    'The trade a journal entry was written for is no longer imported. The entry is kept; re-import the trade to bring it back.',
  journal_collision:
    'Two journal entries now belong to the same position (older history joined them). Both are kept.',
  fees_unrated:
    'Some trades fall before the charge rules BhavBook ships, so their charges are unknown, not guessed.',
  charges_unattached: 'Charges of shares a corporate action cashed out have no position left to sit on.',
  recompute_failed: 'BhavBook could not rebuild positions for this account. Its last good state is kept.',
};

interface FixProps {
  readonly issue: Issue;
  readonly name: (key: string | null) => string;
  readonly done: (message: string) => void;
}

function FillFromStatement({ issue, name, done }: FixProps) {
  const lot = lotSuggestion(issue.subject);
  const accept = useAction(issue, 'accept', done, 'Used the statement lot; the position was recomputed.');
  if (lot === null) return <Unreadable />;
  return (
    <>
      <p>
        The broker's tax report has a lot that would complete this position: {plural(lot.quantity, 'share')}{' '}
        of {name(lot.instrumentKey)} bought on {formatIstDate(lot.entryDateIst)} for{' '}
        <Money valueMicro={lot.totalCostMicro} />.
      </p>
      <Actions issue={issue} done={done} error={accept.error}>
        <Button
          className={TOUCH}
          disabled={accept.isPending}
          onClick={() => {
            accept.mutate();
          }}
        >
          {accept.isPending ? 'Using it…' : 'Use this lot'}
        </Button>
      </Actions>
    </>
  );
}

function Incomplete({ issue, name, done }: FixProps) {
  const position = incompletePosition(issue.subject);
  const [open, setOpen] = useState<'lot' | 'exclude' | null>(null);
  const queryClient = useQueryClient();
  const exclude = useMutation({
    mutationFn: () => addAdjustment(issue.accountId ?? '', { kind: 'exclude', anchorKey: anchorOf(issue) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      done('Excluded the position from every metric; it can be included again.');
    },
  });
  if (position === null || issue.accountId === null) return <Unreadable />;
  return (
    <>
      <p>
        {name(position.instrumentKey)} ({position.bucket.toLowerCase()}):{' '}
        {plural(position.orphanQty, 'share')} sold that BhavBook never saw bought, from{' '}
        {formatIstDate(position.openedAtUtc.slice(0, 10))}. Older trades may be missing: import them, or add
        the shares as an opening lot.
      </p>
      {open === 'lot' ? (
        <OpeningLotForm
          accountId={issue.accountId}
          position={position}
          onDone={async () => {
            await queryClient.invalidateQueries();
            done('Added the opening lot; the position was recomputed.');
          }}
        />
      ) : null}
      {open === 'exclude' ? (
        <div role="group" aria-label="Confirm excluding this position" className="space-y-2">
          <p>Leave this position out of every metric? It stays visible and can be included again.</p>
          <Button
            variant="destructive"
            className={TOUCH}
            disabled={exclude.isPending}
            onClick={() => {
              exclude.mutate();
            }}
          >
            {exclude.isPending ? 'Excluding…' : 'Exclude position'}
          </Button>
        </div>
      ) : null}
      <Actions issue={issue} done={done} error={exclude.error}>
        <Button
          variant="outline"
          className={TOUCH}
          onClick={() => {
            setOpen(open === 'lot' ? null : 'lot');
          }}
        >
          Add opening lot…
        </Button>
        <Button
          variant="outline"
          className={TOUCH}
          onClick={() => {
            setOpen(open === 'exclude' ? null : 'exclude');
          }}
        >
          Exclude…
        </Button>
      </Actions>
    </>
  );
}

/** The position an incomplete-position issue is about, as its anchor (for an exclude adjustment). */
const anchorOf = (issue: Issue): string => {
  const subject = issue.subject as { anchorKey?: unknown } | null;
  return typeof subject?.anchorKey === 'string' ? subject.anchorKey : '';
};

function RedundantLot({ issue, done }: FixProps) {
  const replace = useAction(issue, 'replace', done, 'Replaced the opening lot with the real trades.');
  return (
    <>
      <p>Real trades now cover an opening lot you added. Replace the lot with them?</p>
      <Actions issue={issue} done={done} error={replace.error}>
        <Button
          className={TOUCH}
          disabled={replace.isPending}
          onClick={() => {
            replace.mutate();
          }}
        >
          {replace.isPending ? 'Replacing…' : 'Use the real trades'}
        </Button>
      </Actions>
    </>
  );
}

function Unresolved({ issue, done }: FixProps) {
  const instrument = unresolvedInstrument(issue.subject);
  const queryClient = useQueryClient();
  if (instrument === null) return <Unreadable />;
  return (
    <>
      <p>
        BhavBook cannot tell which instrument “{instrument.alias}” is, so its trades are kept apart from
        everything else.
      </p>
      <MapInstrumentForm
        issueId={issue.id}
        alias={instrument.alias}
        onDone={async () => {
          await queryClient.invalidateQueries();
          done(`Mapped “${instrument.alias}”; positions were recomputed.`);
        }}
      />
      <Actions issue={issue} done={done} error={null} />
    </>
  );
}

function Fees({ issue, name, done }: FixProps) {
  const fees = feeDiscrepancy(issue.subject);
  if (fees === null) return <Unreadable />;
  if (fees.unmatchedRow !== null) {
    return (
      <>
        <p>
          The statement bills {name(fees.unmatchedRow.instrumentKey)} on{' '}
          {formatIstDate(fees.unmatchedRow.dateIst)}, but no trade that day matches it. A trade may be
          missing, or the scrip name may need mapping.
        </p>
        <Actions issue={issue} done={done} error={null} />
      </>
    );
  }
  return (
    <>
      <p>
        {name(fees.instrumentKey)}: the broker billed differently from BhavBook's estimate. The billed amount
        is the one used.
      </p>
      <TableRegion label="Charge differences">
        <table className="w-full min-w-lg border-y border-rule bg-surface text-left text-sm">
          <caption className="sr-only">Estimated and billed charges</caption>
          <thead className="text-ink-muted">
            <tr className="h-8 border-b border-rule">
              <th scope="col" className="px-3 font-medium">
                Date
              </th>
              <th scope="col" className="px-3 font-medium">
                Charge
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Estimated
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Billed
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {fees.differences.map((difference) => (
              <tr key={`${difference.dateIst}|${difference.component}|${difference.scope}`} className="h-8">
                <th scope="row" className="figure px-3 font-normal">
                  {formatIstDate(difference.dateIst)}
                </th>
                <td className="px-3">
                  {COMPONENTS[difference.component] ?? difference.component}
                  {difference.scope === 'note'
                    ? ' (whole contract note)'
                    : difference.scope === 'missing'
                      ? ' (not on the statement)'
                      : ''}
                </td>
                <td className="px-3 text-right">
                  <Money valueMicro={difference.estimatedMicro} />
                </td>
                <td className="px-3 text-right">
                  <Money valueMicro={difference.reportedMicro} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
      <Actions issue={issue} done={done} error={null} />
    </>
  );
}

function Lots({ issue, name, done }: FixProps) {
  const lot = fifoMismatch(issue.subject);
  if (lot === null) return <Unreadable />;
  return (
    <>
      <p>
        {name(lot.isin)}, bought {formatIstDate(lot.buyDateIst)} and sold {formatIstDate(lot.sellDateIst)}:
        the tax report has {plural(lot.statementQuantity, 'share')} (
        <Money valueMicro={lot.statementValueMicro} />
        ), BhavBook has {plural(lot.ourQuantity, 'share')} (<Money valueMicro={lot.ourValueMicro} />
        ). History may be missing, or a corporate action may not be entered.
      </p>
      <Actions issue={issue} done={done} error={null} />
    </>
  );
}

function Generic({ issue, done }: FixProps) {
  return (
    <>
      <p>{GENERIC[issue.kind] ?? 'BhavBook flagged this for a look.'}</p>
      <Actions issue={issue} done={done} error={null} />
    </>
  );
}

function Unreadable() {
  return <p className="text-ink-muted">The details of this issue could not be read.</p>;
}

function useAction(
  issue: Issue,
  action: 'accept' | 'replace' | 'dismiss' | 'reopen',
  done: (message: string) => void,
  message: string,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => issueAction(issue.id, action),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      done(message);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['issues'] });
    },
  });
}

/** The kind's own fixes, then dismiss (or reopen, for a dismissed issue), and the last error. */
function Actions({
  issue,
  done,
  error,
  children,
}: {
  readonly issue: Issue;
  readonly done: (message: string) => void;
  readonly error: unknown;
  readonly children?: ReactNode;
}) {
  const dismissed = issue.status === 'dismissed';
  const toggle = useAction(
    issue,
    dismissed ? 'reopen' : 'dismiss',
    done,
    dismissed ? 'Reopened the issue.' : 'Dismissed the issue.',
  );
  const problem = error ?? toggle.error;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {dismissed ? null : children}
        <Button
          variant="ghost"
          className={TOUCH}
          disabled={toggle.isPending}
          onClick={() => {
            toggle.mutate();
          }}
        >
          {dismissed ? 'Reopen' : 'Dismiss'}
        </Button>
      </div>
      {problem === null ? null : (
        <p role="alert" className="text-sm text-loss">
          {actionError(problem)}
        </p>
      )}
    </div>
  );
}

const FIXES: Readonly<Record<string, (props: FixProps) => ReactNode>> = {
  fill_from_statement: FillFromStatement,
  incomplete_position: Incomplete,
  opening_lot_redundant: RedundantLot,
  unresolved_instrument: Unresolved,
  fee_discrepancy: Fees,
  fifo_mismatch: Lots,
};

export interface IssueCardProps {
  readonly issue: Issue;
  readonly instruments: Readonly<Record<string, string>>;
  readonly onDone: (message: string) => void;
}

export function IssueCard({ issue, instruments, onDone }: IssueCardProps) {
  const name = (key: string | null): string => (key === null ? 'This scrip' : (instruments[key] ?? key));
  const Fix = FIXES[issue.kind] ?? Generic;
  const headingId = `issue-${issue.id}`;
  const instrument = subjectInstrument(issue.subject);
  // An unknown scrip has no instrument yet: its name is what the heading can say.
  const alias = unresolvedInstrument(issue.subject)?.alias ?? null;
  const about = instrument === null ? (alias === null ? null : `“${alias}”`) : name(instrument);
  return (
    <article aria-labelledby={headingId} className="space-y-3 border-b border-rule py-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h3 id={headingId} tabIndex={-1} className="font-semibold focus-visible:outline-none">
          {kindLabel(issue.kind)}
          {about === null ? '' : `: ${about}`}
        </h3>
        <p className="text-sm text-ink-muted">
          {issue.accountNickname ?? 'All accounts'} · since {formatIstDate(issue.createdAt.slice(0, 10))}
        </p>
      </header>
      <Fix issue={issue} name={name} done={onDone} />
    </article>
  );
}
