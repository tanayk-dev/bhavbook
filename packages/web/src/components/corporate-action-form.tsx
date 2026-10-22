// Entering a corporate action (PRD §7.4, ADR-0015): a form per type, then the preview of every account's affected
// open lots (before and after, and any fractions the broker pays in cash), then saving exactly what was previewed.
// Nothing is applied without the preview: changing a field clears it.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';
import { Money } from '@/components/money';
import { TableRegion, TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatIstDate } from '@/lib/format';
import {
  actionError,
  applyAction,
  percentToBp,
  previewAction,
  type ActionPreview,
  type ActionType,
  type CorporateActionInput,
  type PreviewLot,
} from '@/lib/corporate-actions';

const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATIO = /^[1-9]\d{0,5}$/;

/** Per type: what it does, and how its fields read. */
const TYPES: Readonly<
  Record<
    ActionType,
    {
      readonly label: string;
      readonly help: string;
      readonly isin: string;
      readonly newIsin?: string;
      readonly num: string;
      readonly den: string;
    }
  >
> = {
  SPLIT: {
    label: 'Split',
    help: 'Each share becomes several; the total cost and the buy dates stay the same.',
    isin: 'ISIN',
    num: 'Shares after',
    den: 'for every shares before',
  },
  BONUS: {
    label: 'Bonus',
    help: 'Free shares are added at zero cost, dated on the allotment date (for tax).',
    isin: 'ISIN',
    num: 'Bonus shares',
    den: 'for every shares held',
  },
  CONVERSION: {
    label: 'ISIN change',
    help: 'The holding moves to a new ISIN (a renamed security, a DVR conversion); cost and buy dates carry over.',
    isin: 'Old ISIN',
    newIsin: 'New ISIN',
    num: 'New shares',
    den: 'for every old shares',
  },
  DEMERGER: {
    label: 'Demerger',
    help: "A child company's shares are added, carrying the parent's buy dates and a share of its cost (from the company's announcement).",
    isin: 'Parent ISIN',
    newIsin: 'Child ISIN',
    num: 'Child shares',
    den: 'for every parent shares',
  },
};

export interface ActionDraft {
  readonly type: ActionType;
  readonly isin: string;
  readonly newIsin: string;
  readonly exDate: string;
  readonly allotment: string;
  readonly num: string;
  readonly den: string;
  readonly childPercent: string;
}

export const EMPTY_DRAFT: ActionDraft = {
  type: 'SPLIT',
  isin: '',
  newIsin: '',
  exDate: '',
  allotment: '',
  num: '',
  den: '1',
  childPercent: '',
};

/** The server's input, or what is wrong with the draft (in words). */
export function inputOf(draft: ActionDraft): CorporateActionInput | { readonly problem: string } {
  const meta = TYPES[draft.type];
  const isin = draft.isin.trim().toUpperCase();
  const newIsin = draft.newIsin.trim().toUpperCase();
  if (!ISIN.test(isin)) return { problem: `${meta.isin}: a 12-character ISIN, like INE155A01022.` };
  if (meta.newIsin !== undefined && (!ISIN.test(newIsin) || newIsin === isin)) {
    return { problem: `${meta.newIsin}: a 12-character ISIN, different from the first.` };
  }
  if (!DATE.test(draft.exDate)) return { problem: 'Ex-date: the date the action took effect.' };
  if (!RATIO.test(draft.num.trim()) || !RATIO.test(draft.den.trim())) {
    return { problem: 'Ratio: two whole numbers, like 5 for every 1.' };
  }
  const childBp = draft.type === 'DEMERGER' ? percentToBp(draft.childPercent) : null;
  if (draft.type === 'DEMERGER' && childBp === null) {
    return { problem: "Child's share of the cost: a percentage up to 100, like 31.15." };
  }
  if (draft.type === 'BONUS' && draft.allotment !== '' && !DATE.test(draft.allotment)) {
    return { problem: 'Allotment date: a date, or leave it empty to use the ex-date.' };
  }
  return {
    type: draft.type,
    isin,
    ...(meta.newIsin === undefined ? {} : { newIsin }),
    exDateIst: draft.exDate,
    ...(draft.type === 'BONUS' && draft.allotment !== '' ? { allotmentDateIst: draft.allotment } : {}),
    ratioNum: draft.num.trim(),
    ratioDen: draft.den.trim(),
    ...(childBp === null ? {} : { costSplitBp: childBp }),
  };
}

const qty = (value: bigint): string => value.toLocaleString('en-IN');

function LotTable({
  caption,
  lots,
  preview,
}: {
  readonly caption: string;
  readonly lots: readonly PreviewLot[];
  readonly preview: ActionPreview;
}) {
  return (
    <TableRegion label={caption}>
      <table className="w-full min-w-xl border-y border-rule bg-surface text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              Account
            </th>
            <th scope="col" className="px-3 font-medium">
              Instrument
            </th>
            <th scope="col" className="px-3 font-medium">
              Bought
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Shares
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {lots.map((lot, index) => (
            <tr
              key={`${lot.accountId}|${lot.instrumentKey}|${lot.entryDateIst}|${String(index)}`}
              className="h-8"
            >
              <th scope="row" className="px-3 font-normal">
                {preview.accounts[lot.accountId]?.nickname ?? 'An account'} · {lot.bucket.toLowerCase()}
              </th>
              <td className="px-3">{preview.instruments[lot.instrumentKey] ?? lot.instrumentKey}</td>
              <td className="figure px-3">{formatIstDate(lot.entryDateIst)}</td>
              <td className="figure px-3 text-right">{qty(lot.quantity)}</td>
              <td className="px-3 text-right">
                <Money valueMicro={lot.costMicro} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

function Preview({ preview }: { readonly preview: ActionPreview }) {
  if (preview.before.length === 0) {
    return (
      <p className="text-sm">
        No open lots are affected: no account held this ISIN on the ex-date. Saving still records the action
        for trades imported later.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="font-semibold">Open lots before</h3>
      <LotTable caption="Open lots before the action" lots={preview.before} preview={preview} />
      <h3 className="font-semibold">Open lots after</h3>
      <LotTable caption="Open lots after the action" lots={preview.after} preview={preview} />
      {preview.fractions.length === 0 ? null : (
        <ul className="space-y-1 text-sm">
          {preview.fractions.map((fraction) => (
            <li key={`${fraction.accountId}|${fraction.instrumentKey}`}>
              {preview.accounts[fraction.accountId]?.nickname ?? 'An account'}: a fraction of{' '}
              {fraction.numerator.toString()}/{fraction.denominator.toString()} of a share is left over; the
              broker usually pays it in cash.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export interface ActionFormProps {
  readonly initial: ActionDraft;
  /** After saving (refetch, announce). */
  readonly onSaved: (message: string) => void;
}

export function ActionForm({ initial, onSaved }: ActionFormProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ActionDraft>(initial);
  const [previewed, setPreviewed] = useState<{ input: CorporateActionInput; preview: ActionPreview } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const ids = {
    isin: useId(),
    newIsin: useId(),
    exDate: useId(),
    allotment: useId(),
    num: useId(),
    den: useId(),
    child: useId(),
    error: useId(),
    help: useId(),
  };
  const meta = TYPES[draft.type];
  const preview = useMutation({
    mutationFn: (input: CorporateActionInput) => previewAction(input),
    onSuccess: (result, input) => {
      setPreviewed({ input, preview: result });
    },
    onError: (error) => {
      setProblem(actionError(error));
    },
  });
  const apply = useMutation({
    mutationFn: applyAction,
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      setPreviewed(null);
      setDraft(EMPTY_DRAFT);
      onSaved('Saved the corporate action; every account was rebuilt.');
    },
    onError: (error) => {
      setProblem(actionError(error));
    },
  });
  const set = <K extends keyof ActionDraft>(key: K, value: ActionDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    // What was previewed no longer matches: preview again before saving.
    setPreviewed(null);
    setProblem(null);
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const input = inputOf(draft);
    if ('problem' in input) {
      setProblem(input.problem);
      return;
    }
    preview.mutate(input);
  };
  const field = (
    key: 'isin' | 'newIsin' | 'exDate' | 'allotment' | 'num' | 'den' | 'child',
    label: string,
  ) => {
    const draftKey = key === 'child' ? 'childPercent' : key;
    return (
      <div className="space-y-1">
        <Label htmlFor={ids[key]}>{label}</Label>
        <Input
          id={ids[key]}
          className={key === 'isin' || key === 'newIsin' ? 'font-mono' : undefined}
          type={key === 'exDate' || key === 'allotment' ? 'date' : 'text'}
          inputMode={key === 'num' || key === 'den' || key === 'child' ? 'decimal' : undefined}
          maxLength={key === 'isin' || key === 'newIsin' ? 12 : undefined}
          value={draft[draftKey]}
          onChange={(event) => {
            set(draftKey, event.target.value);
          }}
        />
      </div>
    );
  };
  return (
    <form onSubmit={submit} noValidate className="max-w-3xl space-y-4">
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">What happened</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {(Object.keys(TYPES) as ActionType[]).map((type) => (
            <label key={type} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="action-type"
                checked={draft.type === type}
                onChange={() => {
                  set('type', type);
                }}
              />
              {TYPES[type].label}
            </label>
          ))}
        </div>
        <p id={ids.help} className="text-sm text-ink-muted">
          {meta.help}
        </p>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        {field('isin', meta.isin)}
        {meta.newIsin === undefined ? null : field('newIsin', meta.newIsin)}
        {field('exDate', 'Ex-date')}
        {draft.type === 'BONUS' ? field('allotment', 'Allotment date (optional)') : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {field('num', meta.num)}
        {field('den', meta.den)}
        {draft.type === 'DEMERGER' ? field('child', "Child's share of the cost (%)") : null}
      </div>
      <p id={ids.error} role="alert" className="text-sm text-loss">
        {problem ?? ''}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" className={TOUCH} disabled={preview.isPending}>
          {preview.isPending ? 'Working it out…' : 'Preview'}
        </Button>
        {previewed === null ? null : (
          <Button
            type="button"
            className={TOUCH}
            disabled={apply.isPending}
            onClick={() => {
              apply.mutate(previewed.input);
            }}
          >
            {apply.isPending ? 'Saving…' : 'Save this action'}
          </Button>
        )}
      </div>
      {previewed === null ? null : (
        <section aria-label="Preview" className="space-y-2">
          <h2 className="font-semibold">Preview</h2>
          <Preview preview={previewed.preview} />
        </section>
      )}
    </form>
  );
}
