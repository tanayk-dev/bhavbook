// The corporate actions page (PRD §4, §7.4): enter a split, bonus, ISIN change or demerger (with a preview of the
// lots it changes), and see, revert or restore the ones entered. A "possible corporate action" issue links here with
// the form filled in from what BhavBook noticed.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { ActionForm, EMPTY_DRAFT, type ActionDraft } from '@/components/corporate-action-form';
import { TableRegion, TOUCH } from '@/components/settings';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import {
  ACTION_TYPES,
  ISIN,
  actionError,
  corporateActionsQuery,
  setActionStatus,
  type ActionType,
  type StoredAction,
} from '@/lib/corporate-actions';
import { formatIstDate } from '@/lib/format';

export interface CorporateActionsSearch {
  readonly type?: ActionType;
  readonly isin?: string;
  readonly newIsin?: string;
  readonly exDate?: string;
  readonly num?: string;
}

const text = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

export const Route = createFileRoute('/corporate-actions')({
  // What an issue links with: a suggestion to start from, never applied without the preview.
  validateSearch: (search: Record<string, unknown>): CorporateActionsSearch => {
    const type = ACTION_TYPES.find((entry) => entry === search.type);
    const isin = text(search.isin, ISIN);
    const newIsin = text(search.newIsin, ISIN);
    const exDate = text(search.exDate, /^\d{4}-\d{2}-\d{2}$/);
    const num = text(typeof search.num === 'number' ? String(search.num) : search.num, /^[1-9]\d{0,5}$/);
    return {
      ...(type === undefined ? {} : { type }),
      ...(isin === undefined ? {} : { isin }),
      ...(newIsin === undefined ? {} : { newIsin }),
      ...(exDate === undefined ? {} : { exDate }),
      ...(num === undefined ? {} : { num }),
    };
  },
  component: CorporateActionsPage,
});

const ANNOUNCE_DELAY_MS = 50;

const LABELS: Readonly<Record<ActionType, string>> = {
  SPLIT: 'Split',
  BONUS: 'Bonus',
  CONVERSION: 'ISIN change',
  DEMERGER: 'Demerger',
};

/** The action in words: "5 for 1", "1 for 1, 31.15% of the cost to the child". */
function describe(
  action: Extract<StoredAction, { unreadable: false }>,
  name: (isin: string) => string,
): string {
  const ratio = `${action.ratioNum.toString()} for ${action.ratioDen.toString()}`;
  switch (action.type) {
    case 'SPLIT':
      return `${name(action.isin)}: ${ratio}`;
    case 'BONUS':
      return `${name(action.isin)}: ${ratio}${
        action.allotmentDateIst === null ? '' : `, allotted ${formatIstDate(action.allotmentDateIst)}`
      }`;
    case 'CONVERSION':
      return `${name(action.isin)} → ${name(action.newIsin ?? '')}: ${ratio}`;
    case 'DEMERGER': {
      const bp = action.costSplitBp ?? 0n;
      const percent = `${(bp / 100n).toString()}.${(bp % 100n).toString().padStart(2, '0')}`;
      return `${name(action.isin)} → ${name(action.newIsin ?? '')}: ${ratio}, ${percent}% of the cost to the child`;
    }
  }
}

function CorporateActionsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const actions = useQuery(corporateActionsQuery);
  const [notice, setNotice] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const announce = (message: string) => {
    window.clearTimeout(timer.current);
    setNotice('');
    timer.current = window.setTimeout(() => {
      setNotice(message);
    }, ANNOUNCE_DELAY_MS);
  };
  const toggle = useMutation({
    mutationFn: ({ id, to }: { id: string; to: 'revert' | 'restore' }) => setActionStatus(id, to),
    onSuccess: async (_result, { to }) => {
      await queryClient.invalidateQueries();
      announce(
        to === 'revert'
          ? 'Reverted; every account was rebuilt without it.'
          : 'Restored; every account was rebuilt.',
      );
    },
    onError: async (error) => {
      announce(actionError(error));
      await queryClient.invalidateQueries({ queryKey: ['corporate-actions'] });
    },
  });
  const disconnection = actions.error instanceof ApiError ? actions.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  const initial: ActionDraft = {
    ...EMPTY_DRAFT,
    ...(search.type === undefined ? {} : { type: search.type }),
    ...(search.isin === undefined ? {} : { isin: search.isin }),
    ...(search.newIsin === undefined ? {} : { newIsin: search.newIsin }),
    ...(search.exDate === undefined ? {} : { exDate: search.exDate }),
    ...(search.num === undefined ? {} : { num: search.num }),
  };
  const name = (isin: string) => {
    const known = actions.data?.instruments[isin];
    return known === undefined ? isin : `${known} (${isin})`;
  };
  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold">Corporate actions</h1>
        <p role="status" className="text-sm">
          {notice}
        </p>
      </div>
      <section aria-labelledby="new-action" className="space-y-3">
        <h2 id="new-action" className="font-semibold">
          Enter an action
        </h2>
        {search.isin === undefined ? null : (
          <p className="text-sm">
            Filled in from what BhavBook noticed in your trades. Check it against the company&apos;s
            announcement, then preview.
          </p>
        )}
        {/* Keyed by the suggestion: following another issue's link starts from its details. */}
        <ActionForm
          key={JSON.stringify(search)}
          initial={initial}
          onSaved={(message) => {
            announce(message);
            // The suggestion is used up: a reload must not offer it again.
            void navigate({ search: {} });
          }}
        />
      </section>
      <section aria-labelledby="entered" className="space-y-3">
        <h2 id="entered" className="font-semibold">
          Entered
        </h2>
        {actions.isPending ? <LoadingRows label="Loading corporate actions" rows={3} /> : null}
        {actions.isError ? (
          <ErrorState
            message="Could not read the corporate actions."
            retrying={actions.isFetching}
            onRetry={() => {
              void actions.refetch();
            }}
          />
        ) : null}
        {actions.isSuccess && actions.data.actions.length === 0 ? (
          <EmptyState title="None entered">
            Splits, bonuses, ISIN changes and demergers you enter appear here, and can be reverted.
          </EmptyState>
        ) : null}
        {actions.isSuccess && actions.data.actions.length > 0 ? (
          <TableRegion label="Entered corporate actions">
            <table className="w-full min-w-xl border-y border-rule bg-surface text-left text-sm">
              <caption className="sr-only">Corporate actions entered, newest ex-date first</caption>
              <thead className="text-ink-muted">
                <tr className="h-8 border-b border-rule">
                  <th scope="col" className="px-3 font-medium">
                    Action
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Ex-date
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Details
                  </th>
                  <th scope="col" className="px-3 font-medium">
                    Status
                  </th>
                  <th scope="col" className="px-3">
                    <span className="sr-only">Change</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {actions.data.actions.map((action) => {
                  const to = action.status === 'active' ? 'revert' : 'restore';
                  return (
                    <tr key={action.id} className="h-11">
                      <th scope="row" className="px-3 font-medium">
                        {action.unreadable ? 'Unreadable' : LABELS[action.type]}
                      </th>
                      <td className="figure px-3">
                        {action.unreadable ? '' : formatIstDate(action.exDateIst)}
                      </td>
                      <td className="px-3">
                        {action.unreadable
                          ? 'This stored action no longer passes the rules; revert it, then enter it again.'
                          : describe(action, name)}
                      </td>
                      <td className="px-3">{action.status === 'active' ? 'Active' : 'Reverted'}</td>
                      <td className="px-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className={TOUCH}
                          disabled={toggle.isPending}
                          onClick={() => {
                            toggle.mutate({ id: action.id, to });
                          }}
                        >
                          {to === 'revert' ? 'Revert' : 'Restore'}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableRegion>
        ) : null}
      </section>
    </div>
  );
}
