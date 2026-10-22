// One inbox issue (PRD §4): what it means in plain words, and its fixes. Fixes and Dismiss are offered on open
// issues only; a dismissed issue can be reopened, and a resolved one is read-only. Every fix is the user's choice and
// is recomputed on the server (ADR-0013). One action per card at a time. Amounts go through Money (formatINR),
// dates are IST, and nothing relies on colour alone.
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { MapInstrumentForm, OpeningLotForm } from '@/components/issue-fixes';
import { Money } from '@/components/money';
import { TableRegion, TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { ISIN } from '@/lib/corporate-actions';
import { formatIstDate, istDateOf } from '@/lib/format';
import { mergeEntries, positionRefOf } from '@/lib/journal';
import { positionQuery } from '@/lib/positions';
import {
  actionError,
  addAdjustment,
  feeDiscrepancy,
  fifoMismatch,
  incompletePosition,
  issueAction,
  journalCollision,
  suspectedAction,
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
    'The trades look like a split, bonus or other corporate action that has not been entered. If it is real, enter it on the Corporate actions page; if not, dismiss this.',
  cash_in_lieu: 'A corporate action left a fraction of a share, which the broker pays out as cash.',
  journal_unattached:
    'The trade a journal entry was written for is no longer imported. The entry is kept; re-import the trade to bring it back.',
  journal_collision:
    'Two journal entries now belong to the same position (older history joined them). Merge them into the one you choose (its values win; empty fields, including an initial stop, are filled from the other; notes are joined; tags and screenshots move over), or keep both.',
  fees_unrated:
    'Some trades fall before the charge rules BhavBook ships, so their charges are unknown, not guessed.',
  charges_unattached: 'Charges of shares a corporate action cashed out have no position left to sit on.',
  recompute_failed: 'BhavBook could not rebuild positions for this account. Its last good state is kept.',
  opening_lot_redundant: 'Real trades now cover an opening lot you added.',
};

/** What a fix reports back: success (the card will usually leave the list) or a failure message. */
export interface Outcome {
  readonly onDone: (message: string) => void;
  readonly onFailed: (message: string) => void;
}

interface FixProps extends Outcome {
  readonly issue: Issue;
  readonly name: (key: string | null) => string;
  /** Any action of this card is running: the others wait. */
  readonly busy: boolean;
}

/** Refetches everything a fix can change, then reports. */
function useRefresh() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries();
}

function useAction(
  issue: Issue,
  action: 'accept' | 'replace' | 'dismiss' | 'reopen',
  outcome: Outcome,
  message: string,
) {
  const refresh = useRefresh();
  return useMutation({
    mutationKey: ['issue', issue.id],
    mutationFn: () => issueAction(issue.id, action),
    onSuccess: async () => {
      await refresh();
      outcome.onDone(message);
    },
    onError: async (error) => {
      // Announced by the page: if the issue changed meanwhile, the refetch removes this card with its alert.
      outcome.onFailed(actionError(error));
      await refresh();
    },
  });
}

function FillFromStatement({ issue, name, busy, ...outcome }: FixProps) {
  const lot = lotSuggestion(issue.subject);
  const accept = useAction(issue, 'accept', outcome, 'Used the statement lot; the position was recomputed.');
  if (lot === null) return <Unreadable />;
  return (
    <>
      <p>
        The broker's tax report has a lot that would complete this position: {plural(lot.quantity, 'share')}{' '}
        of {name(lot.instrumentKey)} bought on {formatIstDate(lot.entryDateIst)} for{' '}
        <Money valueMicro={lot.totalCostMicro} />.
      </p>
      <Actions issue={issue} busy={busy} error={accept.error} {...outcome}>
        <Button
          className={TOUCH}
          disabled={busy}
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

function Incomplete({ issue, name, busy, ...outcome }: FixProps) {
  const position = incompletePosition(issue.subject);
  const [open, setOpen] = useState<'lot' | 'exclude' | null>(null);
  const refresh = useRefresh();
  const exclude = useMutation({
    mutationKey: ['issue', issue.id],
    mutationFn: (anchorKey: string) => addAdjustment(issue.accountId ?? '', { kind: 'exclude', anchorKey }),
    onSuccess: async () => {
      await refresh();
      outcome.onDone('Excluded the position from every metric. It stays visible on its account.');
    },
    onError: (error) => {
      outcome.onFailed(actionError(error));
    },
  });
  if (position === null || issue.accountId === null) return <Unreadable />;
  const { accountId } = issue;
  const { anchorKey } = position;
  // An intraday run can't be completed by an older lot (intraday never carries over a day); it can be excluded.
  const canAddLot = position.bucket !== 'INTRADAY';
  return (
    <>
      <p>
        {name(position.instrumentKey)} ({position.bucket.toLowerCase()}):{' '}
        {plural(position.orphanQty, 'share')} sold that BhavBook never saw bought, in a position from{' '}
        {formatIstDate(istDateOf(position.openedAtUtc))}. Older trades may be missing: import them, or add the
        shares as an opening lot.
      </p>
      {open === 'lot' ? (
        <OpeningLotForm
          issueId={issue.id}
          accountId={accountId}
          position={position}
          busy={busy}
          onDone={async () => {
            await refresh();
            outcome.onDone('Added the opening lot; the position was recomputed.');
          }}
        />
      ) : null}
      {open === 'exclude' && anchorKey !== null ? (
        <div role="group" aria-label="Confirm excluding this position" className="space-y-2">
          <p>Leave this position out of every metric? It stays visible on its account.</p>
          <Button
            variant="destructive"
            className={TOUCH}
            disabled={busy}
            onClick={() => {
              exclude.mutate(anchorKey);
            }}
          >
            {exclude.isPending ? 'Excluding…' : 'Exclude position'}
          </Button>
        </div>
      ) : null}
      <Actions issue={issue} busy={busy} error={exclude.error} {...outcome}>
        {canAddLot ? (
          <Button
            variant="outline"
            className={TOUCH}
            disabled={busy}
            aria-expanded={open === 'lot'}
            onClick={() => {
              setOpen(open === 'lot' ? null : 'lot');
            }}
          >
            Add opening lot…
          </Button>
        ) : null}
        {anchorKey === null ? null : (
          <Button
            variant="outline"
            className={TOUCH}
            disabled={busy}
            aria-expanded={open === 'exclude'}
            onClick={() => {
              setOpen(open === 'exclude' ? null : 'exclude');
            }}
          >
            Exclude…
          </Button>
        )}
      </Actions>
    </>
  );
}

function RedundantLot({ issue, busy, ...outcome }: FixProps) {
  const replace = useAction(issue, 'replace', outcome, 'Replaced the opening lot with the real trades.');
  return (
    <>
      <p>{GENERIC.opening_lot_redundant} Replace the lot with them?</p>
      <Actions issue={issue} busy={busy} error={replace.error} {...outcome}>
        <Button
          className={TOUCH}
          disabled={busy}
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

function Unresolved({ issue, busy, ...outcome }: FixProps) {
  const instrument = unresolvedInstrument(issue.subject);
  const refresh = useRefresh();
  if (instrument === null) return <Unreadable />;
  return (
    <>
      <p>
        BhavBook cannot tell which instrument “{instrument.alias}” is, so its trades are kept apart from
        everything else.
      </p>
      {issue.status === 'open' ? (
        <MapInstrumentForm
          issueId={issue.id}
          alias={instrument.alias}
          busy={busy}
          onDone={async () => {
            await refresh();
            outcome.onDone(`Mapped “${instrument.alias}”; positions were recomputed.`);
          }}
        />
      ) : null}
      <Actions issue={issue} busy={busy} error={null} {...outcome} />
    </>
  );
}

const SCOPE_NOTES: Readonly<Record<string, string>> = { note: ' (whole contract note)', missing: '' };

function Fees({ issue, name, busy, ...outcome }: FixProps) {
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
        <Actions issue={issue} busy={busy} error={null} {...outcome} />
      </>
    );
  }
  const missing = fees.differences.some((difference) => difference.scope === 'missing');
  return (
    <>
      <p>
        {name(fees.instrumentKey)}:{' '}
        {missing
          ? "the statement has no row for some of this position's trades, so BhavBook's estimate is kept for them."
          : "the broker billed differently from BhavBook's estimate. The billed amount is the one used."}
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
                  {SCOPE_NOTES[difference.scope] ?? ''}
                </td>
                <td className="px-3 text-right">
                  <Money valueMicro={difference.estimatedMicro} />
                </td>
                <td className="px-3 text-right">
                  {difference.scope === 'missing' ? (
                    <span className="text-ink-muted">Not on the statement</span>
                  ) : (
                    <Money valueMicro={difference.reportedMicro} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
      <Actions issue={issue} busy={busy} error={null} {...outcome} />
    </>
  );
}

function Lots({ issue, name, busy, ...outcome }: FixProps) {
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
      <Actions issue={issue} busy={busy} error={null} {...outcome} />
    </>
  );
}

function Generic({ issue, busy, ...outcome }: FixProps) {
  return (
    <>
      <p>{GENERIC[issue.kind] ?? 'BhavBook flagged this for a look.'}</p>
      <Actions issue={issue} busy={busy} error={null} {...outcome} />
    </>
  );
}

function Unreadable() {
  return <p className="text-ink-muted">The details of this issue could not be read.</p>;
}

/**
 * The kind's own fixes and Dismiss on an open issue; Reopen on a dismissed one; nothing on a resolved one. The last
 * error shows here too (the page also announces it).
 */
function Actions({
  issue,
  busy,
  error,
  children,
  dismissLabel = 'Dismiss',
  ...outcome
}: Outcome & {
  readonly issue: Issue;
  readonly busy: boolean;
  readonly error: unknown;
  readonly children?: ReactNode;
  /** What dismissing means for this kind ("Keep both" for a journal collision). */
  readonly dismissLabel?: string;
}) {
  const dismissed = issue.status === 'dismissed';
  const toggle = useAction(
    issue,
    dismissed ? 'reopen' : 'dismiss',
    outcome,
    dismissed ? 'Reopened the issue.' : 'Dismissed the issue.',
  );
  if (issue.status === 'resolved') return <p className="text-sm text-ink-muted">Resolved: nothing to do.</p>;
  const problem = error ?? toggle.error;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {dismissed ? null : children}
        <Button
          variant="ghost"
          className={TOUCH}
          disabled={busy}
          onClick={() => {
            toggle.mutate();
          }}
        >
          {dismissed ? 'Reopen' : dismissLabel}
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

/** What BhavBook noticed, and a link to enter it with the form filled in (never applied without its preview). */
function Suspected({ issue, name, busy, ...outcome }: FixProps) {
  const suspicion = suspectedAction(issue.subject);
  // Details it cannot read: the plain text, and it can still be dismissed.
  if (suspicion === null) return <Generic issue={issue} name={name} busy={busy} {...outcome} />;
  const split = suspicion.kind === 'split_or_bonus';
  const isin = split ? suspicion.instrumentKey : suspicion.fromInstrument;
  // Only ISINs can be entered: a scrip without one is mapped in this inbox first.
  const enterable = ISIN.test(isin) && (split || ISIN.test(suspicion.toInstrument));
  // Sales of N times the holding: a split of N for 1, or a bonus of N − 1 extra shares for each 1 held.
  const links = !enterable
    ? []
    : split
      ? [
          {
            label: `Enter as a split (${suspicion.multiple.toString()} for 1)…`,
            search: {
              type: 'SPLIT' as const,
              isin,
              exDate: suspicion.dateIst,
              num: suspicion.multiple.toString(),
            },
          },
          ...(suspicion.multiple >= 2n
            ? [
                {
                  label: `Enter as a bonus (${(suspicion.multiple - 1n).toString()} for 1)…`,
                  search: {
                    type: 'BONUS' as const,
                    isin,
                    exDate: suspicion.dateIst,
                    num: (suspicion.multiple - 1n).toString(),
                  },
                },
              ]
            : []),
        ]
      : [
          {
            label: 'Enter it…',
            search: {
              type: 'CONVERSION' as const,
              isin,
              newIsin: suspicion.toInstrument,
              exDate: suspicion.dateIst,
              num: '1',
            },
          },
        ];
  return (
    <>
      <p>
        {split
          ? `${name(suspicion.instrumentKey)}: sales on ${formatIstDate(suspicion.dateIst)} ran to ${suspicion.multiple.toString()} times the shares held, as after a split or bonus with an ex-date on or before then.`
          : `${name(suspicion.fromInstrument)} stopped trading around ${formatIstDate(suspicion.dateIst)} while still held, and ${name(suspicion.toInstrument)} appeared: an ISIN change or demerger.`}{' '}
        {enterable
          ? 'Check the company announcement, then enter it, or dismiss this if it is wrong.'
          : 'It names a scrip without an ISIN: map it in this inbox first, then enter the action.'}
      </p>
      <Actions issue={issue} busy={busy} error={null} {...outcome}>
        {links.map((link) => (
          <Link
            key={link.label}
            to="/corporate-actions"
            search={link.search}
            className="inline-flex h-11 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground md:h-9"
          >
            {link.label}
          </Link>
        ))}
      </Actions>
    </>
  );
}

/** The start of an entry's thesis, to tell two apart. */
const preview = (text: string | null): string => {
  if (text === null) return 'no thesis';
  // By user-perceived character, so an emoji is never cut in half.
  const characters = Array.from(new Intl.Segmenter().segment(text), (part) => part.segment);
  return characters.length > 80 ? `“${characters.slice(0, 80).join('')}…”` : `“${text}”`;
};

/** Two entries on one position: merge into the one chosen, or keep both (dismiss). */
function Collision({ issue, busy, ...outcome }: FixProps) {
  const collision = journalCollision(issue.subject);
  const ref = collision === null ? '' : positionRefOf(collision.positionId);
  const detail = useQuery({ ...positionQuery(ref), enabled: ref !== '' && issue.status === 'open' });
  const [into, setInto] = useState<string | null>(null);
  const refresh = useRefresh();
  const merge = useMutation({
    mutationKey: ['issue', issue.id],
    mutationFn: (intoId: string) => mergeEntries(issue.id, intoId),
    onSuccess: async () => {
      await refresh();
      outcome.onDone('Merged the entries; the position has one journal entry now.');
    },
    onError: (error) => {
      outcome.onFailed(actionError(error));
    },
  });
  if (collision === null) return <Unreadable />;
  const entries = (detail.data?.journal ?? []).filter((entry) =>
    collision.journalEntryIds.includes(entry.id),
  );
  return (
    <>
      <p>
        {GENERIC.journal_collision}{' '}
        {ref === '' ? null : (
          <Link
            to="/positions/$ref"
            params={{ ref }}
            className="text-primary underline-offset-4 hover:underline"
          >
            Open the position
          </Link>
        )}
      </p>
      {issue.status === 'open' && detail.isPending ? (
        <p className="text-sm text-ink-muted">Reading the two entries…</p>
      ) : null}
      {issue.status === 'open' && detail.isError ? (
        <p className="text-sm text-ink-muted">
          The entries could not be read (the position may have been rebuilt). Keep both, or open the position
          from the review queue.
        </p>
      ) : null}
      {issue.status === 'open' && entries.length > 1 ? (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">Keep which entry?</legend>
          {entries.map((entry) => (
            <label key={entry.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`keep-${issue.id}`}
                checked={into === entry.id}
                onChange={() => {
                  setInto(entry.id);
                }}
              />
              Written {formatIstDate(istDateOf(entry.createdAt))}: {preview(entry.thesis)}
              {entry.reviewedAt === null ? '' : ', reviewed'}
            </label>
          ))}
        </fieldset>
      ) : null}
      <Actions issue={issue} busy={busy} error={merge.error} dismissLabel="Keep both" {...outcome}>
        {entries.length > 1 ? (
          <Button
            className={TOUCH}
            disabled={busy || into === null}
            onClick={() => {
              if (into !== null) merge.mutate(into);
            }}
          >
            {merge.isPending ? 'Merging…' : 'Merge into this one'}
          </Button>
        ) : null}
      </Actions>
    </>
  );
}

const FIXES: Readonly<Record<string, (props: FixProps) => ReactNode>> = {
  corporate_action_suspected: Suspected,
  journal_collision: Collision,
  fill_from_statement: FillFromStatement,
  incomplete_position: Incomplete,
  opening_lot_redundant: RedundantLot,
  unresolved_instrument: Unresolved,
  fee_discrepancy: Fees,
  fifo_mismatch: Lots,
};

export interface IssueCardProps extends Outcome {
  readonly issue: Issue;
  readonly instruments: Readonly<Record<string, string>>;
}

export function IssueCard({ issue, instruments, ...outcome }: IssueCardProps) {
  const busy = useIsMutating({ mutationKey: ['issue', issue.id] }) > 0;
  const name = (key: string | null): string => (key === null ? 'This scrip' : (instruments[key] ?? key));
  const Fix = FIXES[issue.kind] ?? Generic;
  const headingId = `issue-${issue.id}`;
  const instrument = subjectInstrument(issue.subject);
  // An unknown scrip has no instrument yet: its name is what the heading can say.
  const alias = unresolvedInstrument(issue.subject)?.alias ?? null;
  const about = instrument === null ? (alias === null ? null : `“${alias}”`) : name(instrument);
  return (
    <article aria-labelledby={headingId} aria-busy={busy} className="space-y-3 border-b border-rule py-4">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4">
        <h2
          id={headingId}
          tabIndex={-1}
          className="rounded-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          {kindLabel(issue.kind)}
          {about === null ? '' : `: ${about}`}
        </h2>
        <p className="text-sm text-ink-muted">
          {issue.accountNickname ?? 'All accounts'} · since {formatIstDate(istDateOf(issue.createdAt))}
        </p>
      </header>
      <Fix issue={issue} name={name} busy={busy} {...outcome} />
    </article>
  );
}
