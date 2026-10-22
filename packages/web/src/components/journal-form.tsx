// The journal entry of a position (PRD §5.3, §9.2 Q11): setup and mistake tags, thesis, the initial and planned stop,
// target, planned risk and a review note. A draft can be written while the position is open; once it has closed the
// initial stop is fixed (R is measured against the stop as planned). Amounts are typed in rupees and sent as
// micro-rupees, string arithmetic only.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState, type ReactNode, type SyntheticEvent } from 'react';
import { rupeesToMicro } from '@/components/issue-fixes';
import { TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { microToRupees, saveError, saveJournal, type JournalInput } from '@/lib/journal';
import type { JournalEntry, PositionDetail } from '@/lib/positions';
import { tagsQuery } from '@/lib/tags';

const MAX_TEXT = 10_000;
const TEXTAREA =
  'min-h-20 w-full rounded-md border border-input bg-surface px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden';
const SELECT =
  'h-11 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden md:h-9';

interface Fields {
  readonly setupTagId: string;
  readonly mistakeTagIds: readonly string[];
  readonly thesis: string;
  readonly initialStop: string;
  readonly plannedStop: string;
  readonly plannedTarget: string;
  readonly plannedRisk: string;
  readonly reviewNote: string;
}

const AMOUNTS = [
  ['initialStop', 'Initial stop (₹)'],
  ['plannedStop', 'Planned stop (₹)'],
  ['plannedTarget', 'Target (₹)'],
  ['plannedRisk', 'Planned risk (₹)'],
] as const;

function fieldsOf(entry: JournalEntry | null): Fields {
  return {
    setupTagId: entry?.setupTagId ?? '',
    mistakeTagIds: entry?.mistakeTagIds ?? [],
    thesis: entry?.thesis ?? '',
    initialStop: microToRupees(entry?.initialStopMicro ?? null),
    plannedStop: microToRupees(entry?.plannedStopMicro ?? null),
    plannedTarget: microToRupees(entry?.plannedTargetMicro ?? null),
    plannedRisk: microToRupees(entry?.plannedRiskMicro ?? null),
    reviewNote: entry?.reviewNote ?? '',
  };
}

/** An amount as typed, as micro-rupees: null when empty, undefined when it is not an amount. */
function amount(text: string): string | null | undefined {
  if (text.trim() === '') return null;
  return rupeesToMicro(text) ?? undefined;
}

/** The input the server takes, or which amount is malformed. */
function inputOf(fields: Fields, entryId: string | undefined): JournalInput | { readonly bad: string } {
  const amounts: Record<string, string | null> = {};
  for (const [key, label] of AMOUNTS) {
    const value = amount(fields[key]);
    if (value === undefined) return { bad: label };
    amounts[key] = value;
  }
  return {
    ...(entryId === undefined ? {} : { entryId }),
    setupTagId: fields.setupTagId === '' ? null : fields.setupTagId,
    mistakeTagIds: fields.mistakeTagIds,
    thesis: fields.thesis.trim() === '' ? null : fields.thesis,
    initialStopMicro: amounts.initialStop ?? null,
    plannedStopMicro: amounts.plannedStop ?? null,
    plannedTargetMicro: amounts.plannedTarget ?? null,
    plannedRiskMicro: amounts.plannedRisk ?? null,
    reviewNote: fields.reviewNote.trim() === '' ? null : fields.reviewNote,
  };
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint === undefined ? null : (
        <p id={`${id}-hint`} className="text-xs text-ink-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function JournalForm({ detail }: { readonly detail: PositionDetail }) {
  const { position, journal } = detail;
  const [first] = journal;
  const entry = first ?? null;
  const closed = position.state === 'CLOSED';
  const tags = useQuery(tagsQuery);
  const queryClient = useQueryClient();
  const [fields, setFields] = useState<Fields>(() => fieldsOf(entry));
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const ids = {
    setup: useId(),
    thesis: useId(),
    note: useId(),
    mistakes: useId(),
    error: useId(),
    initialStop: useId(),
    plannedStop: useId(),
    plannedTarget: useId(),
    plannedRisk: useId(),
  };
  const save = useMutation({
    mutationFn: (input: JournalInput) => saveJournal(position.ref, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      setMessage('Saved.');
    },
    onError: (error) => {
      setProblem(saveError(error));
    },
  });
  const set = <K extends keyof Fields>(key: K, value: Fields[K]) => {
    setFields((current) => ({ ...current, [key]: value }));
    setProblem(null);
    setMessage('');
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    // With two entries on the position, the form edits the first (the inbox merges or keeps both).
    const input = inputOf(fields, journal.length > 1 ? entry?.id : undefined);
    if ('bad' in input) {
      setProblem(
        `${input.bad}: enter rupees with at most two decimals, for example 1234.50, or leave it empty.`,
      );
      return;
    }
    save.mutate(input);
  };
  const setups = (tags.data ?? []).filter((tag) => tag.kind === 'setup');
  const mistakes = (tags.data ?? []).filter((tag) => tag.kind === 'mistake');
  const lockedStop = closed;
  return (
    <form onSubmit={submit} noValidate className="max-w-3xl space-y-4" aria-describedby={ids.error}>
      {journal.length > 1 ? (
        <p className="text-sm">
          Two journal entries belong to this position. This form edits the older one;{' '}
          <Link to="/issues" className="text-primary underline-offset-4 hover:underline">
            merge them or keep both in Issues
          </Link>
          .
        </p>
      ) : null}
      {closed ? null : (
        <p className="text-sm text-ink-muted">
          The position is open: this is a draft. It stays as the position closes.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={ids.setup} label="Setup">
          <select
            id={ids.setup}
            className={SELECT}
            value={fields.setupTagId}
            onChange={(event) => {
              set('setupTagId', event.target.value);
            }}
          >
            <option value="">None</option>
            {setups.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        </Field>
        <fieldset className="space-y-1">
          <legend id={ids.mistakes} className="text-sm font-medium">
            Mistakes
          </legend>
          {mistakes.length === 0 ? (
            <p className="text-sm text-ink-muted">
              No mistake tags yet: add them in{' '}
              <Link to="/settings" className="text-primary underline-offset-4 hover:underline">
                Settings
              </Link>
              .
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {mistakes.map((tag) => (
                <label key={tag.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={fields.mistakeTagIds.includes(tag.id)}
                    onChange={(event) => {
                      set(
                        'mistakeTagIds',
                        event.target.checked
                          ? [...fields.mistakeTagIds, tag.id]
                          : fields.mistakeTagIds.filter((id) => id !== tag.id),
                      );
                    }}
                  />
                  {tag.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </div>
      <Field id={ids.thesis} label="Thesis">
        <textarea
          id={ids.thesis}
          className={TEXTAREA}
          maxLength={MAX_TEXT}
          value={fields.thesis}
          onChange={(event) => {
            set('thesis', event.target.value);
          }}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-4">
        {AMOUNTS.map(([key, label]) => {
          const locked = key === 'initialStop' && lockedStop;
          const hint = locked
            ? fields.initialStop === ''
              ? 'Not set when the trade was open; R then uses the planned risk.'
              : 'Fixed once the position closed.'
            : undefined;
          return (
            <Field key={key} id={ids[key]} label={label} {...(hint === undefined ? {} : { hint })}>
              <Input
                id={ids[key]}
                inputMode="decimal"
                value={fields[key]}
                readOnly={locked}
                className="read-only:bg-muted read-only:text-ink-muted"
                {...(locked ? { 'aria-describedby': `${ids[key]}-hint` } : {})}
                onChange={(event) => {
                  set(key, event.target.value);
                }}
              />
            </Field>
          );
        })}
      </div>
      <Field id={ids.note} label="Review note">
        <textarea
          id={ids.note}
          className={TEXTAREA}
          maxLength={MAX_TEXT}
          value={fields.reviewNote}
          onChange={(event) => {
            set('reviewNote', event.target.value);
          }}
        />
      </Field>
      <p id={ids.error} role="alert" className="text-sm text-loss">
        {problem ?? ''}
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" className={TOUCH} disabled={save.isPending}>
          {save.isPending ? 'Saving…' : entry === null ? 'Save journal' : 'Save changes'}
        </Button>
        <p role="status" className="text-sm">
          {message}
        </p>
      </div>
    </form>
  );
}
