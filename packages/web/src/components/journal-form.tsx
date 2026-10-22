// The journal entry of a position (PRD §5.3, §9.2 Q11): setup and mistake tags, thesis, the initial and planned stop,
// target, planned risk and a review note. A draft can be written while the position is open; once it has closed a
// recorded initial stop is fixed (R is measured against the stop as planned), and an empty one can be filled in once
// (ADR-0027). Amounts are typed in rupees and sent as
// micro-rupees, string arithmetic only; an amount left as it was goes back exactly as stored. The form keeps the
// entry it started from: a newer one on the server (merged, reviewed, edited in another tab) replaces an untouched
// form, and a save over it is refused as stale rather than overwriting it.
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

type AmountKey = (typeof AMOUNTS)[number][0];

/** What the form started from: the entry's time, its fields as shown, and its amounts exactly as stored. */
interface Base {
  readonly updatedAt: string | null;
  readonly fields: Fields;
  readonly stored: Readonly<Record<AmountKey, bigint | null>>;
}

function baseOf(entry: JournalEntry | null): Base {
  return {
    updatedAt: entry?.updatedAt ?? null,
    fields: fieldsOf(entry),
    stored: {
      initialStop: entry?.initialStopMicro ?? null,
      plannedStop: entry?.plannedStopMicro ?? null,
      plannedTarget: entry?.plannedTargetMicro ?? null,
      plannedRisk: entry?.plannedRiskMicro ?? null,
    },
  };
}

const sameFields = (a: Fields, b: Fields): boolean => JSON.stringify(a) === JSON.stringify(b);

/** An amount as typed, as micro-rupees: null when empty, undefined when it is not an amount. */
function amount(text: string): string | null | undefined {
  if (text.trim() === '') return null;
  return rupeesToMicro(text) ?? undefined;
}

/** The input the server takes, or which amount is malformed. */
function inputOf(
  fields: Fields,
  base: Base,
  entryId: string | undefined,
): JournalInput | { readonly bad: AmountKey } {
  const amounts: Record<string, string | null> = {};
  for (const [key] of AMOUNTS) {
    // Untouched: exactly what is stored (it may hold finer amounts than a form can type, or be locked).
    const value =
      fields[key] === base.fields[key] ? (base.stored[key]?.toString() ?? null) : amount(fields[key]);
    if (value === undefined) return { bad: key };
    amounts[key] = value;
  }
  return {
    ...(entryId === undefined ? {} : { entryId }),
    expectedUpdatedAt: base.updatedAt,
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
  const [base, setBase] = useState<Base>(() => baseOf(entry));
  const [fields, setFields] = useState<Fields>(() => base.fields);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [badAmount, setBadAmount] = useState<AmountKey | null>(null);
  const dirty = !sameFields(fields, base.fields);
  const serverAt = entry?.updatedAt ?? null;
  // The server's entry moved on (adjusting state while rendering, as React documents for derived resets).
  let changedElsewhere = false;
  if (serverAt !== base.updatedAt) {
    const server = baseOf(entry);
    if (sameFields(server.fields, base.fields)) {
      // Only its time changed (a review, an entry created for a screenshot): keep what is being typed.
      setBase(server);
    } else if (!dirty) {
      setBase(server);
      setFields(server.fields);
    } else {
      changedElsewhere = true;
    }
  }
  const ids = {
    setup: useId(),
    thesis: useId(),
    note: useId(),
    error: useId(),
    initialStop: useId(),
    plannedStop: useId(),
    plannedTarget: useId(),
    plannedRisk: useId(),
  };
  const save = useMutation({
    mutationFn: ({ input }: { input: JournalInput; saved: Fields }) => saveJournal(position.ref, input),
    onSuccess: async (_id, { saved }) => {
      // What was saved is the new starting point; the refetch brings the server's time (and trimmed text).
      setBase((current) => ({ ...current, fields: saved }));
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
    setBadAmount(null);
    setMessage('');
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    // With two entries on the position, the form edits the first (the inbox merges or keeps both).
    const input = inputOf(fields, base, journal.length > 1 ? entry?.id : undefined);
    if ('bad' in input) {
      const label = AMOUNTS.find(([key]) => key === input.bad)?.[1] ?? 'An amount';
      setBadAmount(input.bad);
      setProblem(`${label}: enter rupees with at most two decimals, for example 1234.50, or leave it empty.`);
      return;
    }
    save.mutate({ input, saved: fields });
  };
  const setups = (tags.data ?? []).filter((tag) => tag.kind === 'setup');
  const mistakes = (tags.data ?? []).filter((tag) => tag.kind === 'mistake');
  // Closed with a stop recorded: fixed. Closed without one: it can still be written down, once (ADR-0027).
  const lockedStop = closed && base.stored.initialStop !== null;
  const fillableStop = closed && base.stored.initialStop === null;
  return (
    <form onSubmit={submit} noValidate className="max-w-3xl space-y-4">
      {changedElsewhere ? (
        <p role="alert" className="text-sm">
          This entry changed elsewhere (merged, reviewed or edited in another tab). Saving would overwrite it:
          copy what you typed, then reload.
        </p>
      ) : null}
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
          <legend className="text-sm font-medium">Mistakes</legend>
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
          const hint =
            key !== 'initialStop'
              ? undefined
              : locked
                ? 'Fixed once the position closed.'
                : fillableStop
                  ? 'Not recorded while the trade was open: add the stop you had at entry. Once saved it is fixed.'
                  : undefined;
          return (
            <Field key={key} id={ids[key]} label={label} {...(hint === undefined ? {} : { hint })}>
              <Input
                id={ids[key]}
                inputMode="decimal"
                value={fields[key]}
                readOnly={locked}
                className="read-only:bg-muted read-only:text-ink-muted"
                {...(hint !== undefined ? { 'aria-describedby': `${ids[key]}-hint` } : {})}
                {...(badAmount === key ? { 'aria-invalid': true, 'aria-describedby': ids.error } : {})}
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
