// The forms behind the inbox's fixes (PRD §4, ADR-0013): an opening lot for an incomplete position, and the
// instrument mapping for an unknown scrip. Each is the user's explicit choice; the server recomputes.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';
import { TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { istDateOf } from '@/lib/format';
import {
  actionError,
  addAdjustment,
  instrumentSuggestions,
  mapInstrument,
  type IncompletePosition,
  type InstrumentTarget,
} from '@/lib/issues';

const MICRO_DIGITS = 6;
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

/**
 * A rupee amount as typed ("₹35,200", "1234.5") as micro-rupees in a decimal string, or null when it is not a
 * positive amount with at most two decimals. String arithmetic only: money never passes through a float.
 */
export function rupeesToMicro(text: string): string | null {
  const plain = text.replace(/[₹,\s]/g, '');
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(plain.startsWith('.') ? `0${plain}` : plain);
  if (match === null) return null;
  const micro = BigInt(match[1] ?? '0') * 1_000_000n + BigInt((match[2] ?? '').padEnd(MICRO_DIGITS, '0'));
  return micro > 0n ? micro.toString() : null;
}

export interface OpeningLotFormProps {
  /** The issue this fixes: the card disables its other actions while this one runs. */
  readonly issueId: string;
  readonly accountId: string;
  readonly position: IncompletePosition;
  /** After the server has applied the fix (refetch, announce). */
  readonly onDone: () => Promise<void>;
  readonly busy: boolean;
}

/** The shares the position sold but never bought here: how many, what they cost, and when they were bought. */
export function OpeningLotForm({ issueId, accountId, position, onDone, busy }: OpeningLotFormProps) {
  const [quantity, setQuantity] = useState(position.orphanQty.toString());
  const [cost, setCost] = useState('');
  const [date, setDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { quantity: useId(), cost: useId(), date: useId(), error: useId() };
  const firstTrade = istDateOf(position.openedAtUtc);
  const mutation = useMutation({
    mutationKey: ['issue', issueId],
    mutationFn: (input: Parameters<typeof addAdjustment>[1]) => addAdjustment(accountId, input),
    onSuccess: async () => {
      await onDone();
    },
    onError: (error) => {
      setProblem(actionError(error));
    },
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const totalCostMicro = rupeesToMicro(cost);
    if (!/^[1-9]\d{0,11}$/.test(quantity)) {
      setProblem('Enter how many shares, a whole number.');
    } else if (totalCostMicro === null) {
      setProblem('Enter what they cost in total, in rupees, for example 35,200 or 35200.50.');
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > firstTrade) {
      setProblem("Enter when they were bought: on or before the position's first trade.");
    } else {
      setProblem(null);
      mutation.mutate({
        kind: 'opening_lot',
        instrumentKey: position.instrumentKey,
        bucket: position.bucket === 'MTF' ? 'MTF' : 'DELIVERY',
        quantity,
        totalCostMicro,
        entryDateIst: date,
      });
    }
  };
  const invalid = problem === null ? {} : { 'aria-invalid': true, 'aria-describedby': ids.error };
  return (
    <form onSubmit={submit} noValidate className="grid max-w-xl gap-3 sm:grid-cols-3">
      <div className="space-y-1">
        <Label htmlFor={ids.quantity}>Shares</Label>
        <Input
          id={ids.quantity}
          inputMode="numeric"
          value={quantity}
          onChange={(event) => {
            setQuantity(event.target.value);
            setProblem(null);
          }}
          {...invalid}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.cost}>Total cost (₹)</Label>
        <Input
          id={ids.cost}
          inputMode="decimal"
          value={cost}
          onChange={(event) => {
            setCost(event.target.value);
            setProblem(null);
          }}
          {...invalid}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.date}>Bought on</Label>
        <Input
          id={ids.date}
          type="date"
          max={firstTrade}
          value={date}
          onChange={(event) => {
            setDate(event.target.value);
            setProblem(null);
          }}
          {...invalid}
        />
      </div>
      <p id={ids.error} role="alert" className="text-sm text-loss sm:col-span-3">
        {problem ?? ''}
      </p>
      <div className="sm:col-span-3">
        <Button type="submit" className={TOUCH} disabled={busy || mutation.isPending}>
          {mutation.isPending ? 'Adding…' : 'Add opening lot'}
        </Button>
      </div>
    </form>
  );
}

export interface MapInstrumentFormProps {
  readonly issueId: string;
  readonly alias: string;
  /** After the server has applied the fix (refetch, announce). */
  readonly onDone: () => Promise<void>;
  readonly busy: boolean;
}

/** Which instrument an unknown scrip name is: a suggestion, an ISIN typed in, or its own instrument with no ISIN. */
export function MapInstrumentForm({ issueId, alias, onDone, busy }: MapInstrumentFormProps) {
  const suggestions = useQuery({
    queryKey: ['issues', issueId, 'suggestions'],
    queryFn: () => instrumentSuggestions(issueId),
  });
  const [choice, setChoice] = useState<string>('isin');
  const [isin, setIsin] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const groupId = useId();
  const isinLabel = useId();
  const mutation = useMutation({
    mutationKey: ['issue', issueId],
    mutationFn: (target: InstrumentTarget) => mapInstrument(issueId, target),
    onSuccess: async () => {
      await onDone();
    },
    onError: (error) => {
      setProblem(actionError(error));
    },
  });
  const choose = (value: string) => {
    setChoice(value);
    setProblem(null);
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (choice === 'new') {
      mutation.mutate({ newDisplayName: alias });
      return;
    }
    const picked = suggestions.data?.find((entry) => entry.instrumentId === choice);
    const target = picked?.isin ?? isin.trim().toUpperCase();
    if (ISIN.test(target)) {
      // A new instrument takes this name; an existing one keeps its own (the server never renames it).
      mutation.mutate({ isin: target, displayName: picked?.name ?? alias });
    } else {
      setProblem('Enter a 12-character ISIN, like INE002A01018.');
    }
  };
  const options = (suggestions.data ?? []).filter((entry) => entry.isin !== null);
  return (
    <form onSubmit={submit} noValidate className="max-w-xl space-y-3">
      <fieldset aria-labelledby={groupId} className="space-y-2">
        <legend id={groupId} className="text-sm font-medium">
          Which instrument is “{alias}”?
        </legend>
        {suggestions.isPending ? <p className="text-sm text-ink-muted">Looking for likely matches…</p> : null}
        {options.map((entry) => (
          <label key={entry.instrumentId} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={groupId}
              value={entry.instrumentId}
              checked={choice === entry.instrumentId}
              onChange={() => {
                choose(entry.instrumentId);
              }}
            />
            {entry.name} <span className="font-mono text-[13px] text-ink-muted">{entry.isin}</span>
          </label>
        ))}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name={groupId}
              value="isin"
              checked={choice === 'isin'}
              onChange={() => {
                choose('isin');
              }}
            />
            <span id={isinLabel}>This ISIN:</span>
          </label>
          <Input
            aria-label={`ISIN for ${alias}`}
            aria-describedby={isinLabel}
            className="h-8 w-40 font-mono"
            value={isin}
            maxLength={12}
            onFocus={() => {
              choose('isin');
            }}
            onChange={(event) => {
              setIsin(event.target.value);
              setProblem(null);
            }}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={groupId}
            value="new"
            checked={choice === 'new'}
            onChange={() => {
              choose('new');
            }}
          />
          It has no ISIN: keep it as its own instrument
        </label>
      </fieldset>
      <p role="alert" className="text-sm text-loss">
        {problem ?? ''}
      </p>
      <Button type="submit" className={TOUCH} disabled={busy || mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Use this instrument'}
      </Button>
    </form>
  );
}
