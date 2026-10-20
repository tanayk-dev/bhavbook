// Settings building blocks (PRD §4): inline rename, the confirm-then-move of an account (PRD §2 C5: a move
// recomputes the account), the breakeven threshold, and the read-only fee-rule versions. Keyboard-first: every
// step that replaces the focused control puts focus somewhere sensible, and results are announced by the page.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { formatIstDate } from '@/lib/format';
import { profilesQuery, saveError, type Profile } from '@/lib/profiles';
import { moveAccount, saveBreakeven, settingsQuery, type FeeRuleVersion } from '@/lib/settings';

export const TOUCH = 'max-md:h-11';

/** Focus after React has replaced the element (the next frame). */
export const focusLater = (target: { readonly current: HTMLElement | null }) => {
  requestAnimationFrame(() => target.current?.focus());
};

/** A wide table in a labelled, focusable scroll region: the page itself never scrolls sideways. */
export function TableRegion({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  // A keyboard user must be able to scroll it, so it is focusable and named.
  return (
    <div role="region" aria-label={label} tabIndex={0} className="overflow-x-auto rounded-sm">
      {children}
    </div>
  );
}

export interface InlineRenameProps {
  /** What is being renamed, for the field's label ("profile name", "nickname"). */
  readonly what: string;
  readonly value: string;
  readonly kind: 'profile' | 'account' | 'tag';
  readonly save: (value: string) => Promise<void>;
  readonly onSaved: (value: string) => void;
  /** The query to refresh after a save (default: profiles). */
  readonly queryKey?: readonly unknown[];
}

/** A name with a Rename button that turns into a small form; Escape cancels and focus returns to the button. */
export function InlineRename({
  what,
  value,
  kind,
  save,
  onSaved,
  queryKey = profilesQuery.queryKey,
}: InlineRenameProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const fieldId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = () => {
    setEditing(false);
    focusLater(button);
  };
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: async (_, saved) => {
      await queryClient.invalidateQueries({ queryKey });
      close();
      onSaved(saved.trim());
    },
    onError: () => input.current?.focus(),
  });
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  if (!editing) {
    return (
      <span className="flex items-center justify-between gap-3">
        <span>{value}</span>
        <Button
          ref={button}
          variant="ghost"
          size="sm"
          className={TOUCH}
          aria-label={`Rename ${value}`}
          onClick={() => {
            setDraft(value);
            mutation.reset();
            setEditing(true);
          }}
        >
          Rename
        </Button>
      </span>
    );
  }
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (draft.trim() === value) close();
    else mutation.mutate(draft);
  };
  const error = mutation.isError ? saveError(mutation.error, kind) : null;
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-start gap-2 py-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !mutation.isPending) close();
      }}
    >
      <Label htmlFor={fieldId} className="sr-only">
        New {what}
      </Label>
      <div className="min-w-40 flex-1">
        <Input
          ref={input}
          id={fieldId}
          value={draft}
          maxLength={40}
          required
          autoComplete="off"
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setDraft(event.target.value);
            mutation.reset();
          }}
        />
        <p id={errorId} role="alert" className="text-sm text-loss">
          {error ?? ''}
        </p>
      </div>
      <Button type="submit" size="sm" className={TOUCH} disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save'}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={TOUCH}
        disabled={mutation.isPending}
        onClick={close}
      >
        Cancel
      </Button>
    </form>
  );
}

export interface MoveAccountProps {
  readonly account: { readonly id: string; readonly nickname: string };
  readonly from: Profile;
  readonly profiles: readonly Profile[];
  readonly onMoved: (message: string) => void;
}

const positions = (count: number): string =>
  `${count.toLocaleString('en-IN')} position${count === 1 ? '' : 's'}`;

/** Pick another profile, then confirm: the move recomputes the account's positions (PRD §2 C5). */
export function MoveAccount({ account, from, profiles, onMoved }: MoveAccountProps) {
  const queryClient = useQueryClient();
  const targets = profiles.filter((profile) => profile.id !== from.id);
  const [chosen, setChosen] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const fieldId = useId();
  const start = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  // The chosen target while it is still another profile; otherwise the first one (the list changes after a move).
  const target = targets.find((profile) => profile.id === chosen) ?? targets[0];
  const mutation = useMutation({
    mutationFn: (to: { readonly id: string; readonly name: string }) => moveAccount(account.id, to.id),
    onSuccess: async (recomputed, to) => {
      setConfirming(false);
      setChosen(undefined);
      await queryClient.invalidateQueries({ queryKey: profilesQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
      onMoved(`Moved ${account.nickname} to ${to.name} and recomputed ${positions(recomputed)}.`);
      focusLater(start);
    },
  });
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  if (target === undefined) return <span className="text-ink-muted">Create another profile to move it.</span>;
  const cancel = () => {
    setConfirming(false);
    mutation.reset();
    focusLater(start);
  };
  if (confirming) {
    return (
      <div role="group" aria-label={`Confirm moving ${account.nickname}`} className="space-y-2 py-1">
        <p>
          Move <strong>{account.nickname}</strong> to <strong>{target.name}</strong>? Its positions are
          recomputed.
        </p>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-loss">
            {saveError(mutation.error, 'account')}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            ref={confirmButton}
            size="sm"
            className={TOUCH}
            disabled={mutation.isPending}
            onClick={() => {
              mutation.mutate({ id: target.id, name: target.name });
            }}
          >
            {mutation.isPending ? 'Moving…' : 'Move and recompute'}
          </Button>
          <Button variant="ghost" size="sm" className={TOUCH} disabled={mutation.isPending} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <span className="flex items-center gap-2">
      <Label htmlFor={fieldId} className="sr-only">
        Move {account.nickname} to
      </Label>
      <select
        id={fieldId}
        value={target.id}
        className="h-11 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-8"
        onChange={(event) => {
          setChosen(event.target.value);
          mutation.reset();
        }}
      >
        {targets.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <Button
        ref={start}
        variant="outline"
        size="sm"
        className={TOUCH}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Move…
      </Button>
    </span>
  );
}

const MAX_BREAKEVEN_WHOLE = '1000000';

/** "₹1,000.50" or " 1000.5 " as the server's form ("1000.5"), or a message saying what is wrong. */
export function parseRupees(text: string): { readonly value: string } | { readonly error: string } {
  const plain = text.replace(/[₹,\s]/g, '');
  const normalised = plain.startsWith('.') ? `0${plain}` : plain;
  if (!/^\d+(\.\d+)?$/.test(normalised))
    return { error: 'Enter an amount in rupees, for example 10 or 12.50.' };
  const [rawWhole = '0', fraction = ''] = normalised.split('.');
  if (fraction.length > 2) return { error: 'Use at most two decimals (paise).' };
  const whole = rawWhole.replace(/^0+(?=\d)/, '');
  const overCap =
    whole.length > MAX_BREAKEVEN_WHOLE.length ||
    (whole.length === MAX_BREAKEVEN_WHOLE.length && whole > MAX_BREAKEVEN_WHOLE) ||
    (whole === MAX_BREAKEVEN_WHOLE && /[1-9]/.test(fraction));
  if (overCap) return { error: 'The threshold can be at most ₹10,00,000.' };
  return { value: fraction === '' ? whole : `${whole}.${fraction}` };
}

export interface BreakevenFormProps {
  readonly currentMicro: bigint;
  readonly onSaved: (message: string) => void;
}

export function BreakevenForm({ currentMicro, onSaved }: BreakevenFormProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = useId();
  const errorId = useId();
  const mutation = useMutation({
    mutationFn: saveBreakeven,
    onSuccess: async (_, rupees) => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
      onSaved(`Breakeven threshold saved: ₹${rupees}.`);
    },
    onError: (error) => {
      setProblem(
        error instanceof ApiError && error.status === 400
          ? 'The server refused that amount.'
          : 'Could not save. Try again.',
      );
    },
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const parsed = parseRupees(draft);
    if ('error' in parsed) setProblem(parsed.error);
    else mutation.mutate(parsed.value);
  };
  return (
    <form onSubmit={submit} className="max-w-md space-y-2" noValidate>
      <p className="text-ink-muted">
        A closed trade whose net P&amp;L is within this amount of zero counts as breakeven: it is a trade, but
        not a win or a loss. Now <Money valueMicro={currentMicro} />.
      </p>
      <div className="flex items-end gap-2">
        <div className="flex-1 space-y-1.5">
          <Label htmlFor={fieldId}>New threshold (₹)</Label>
          <Input
            id={fieldId}
            inputMode="decimal"
            value={draft}
            autoComplete="off"
            placeholder="e.g. 10 or 12.50"
            aria-invalid={problem === null ? undefined : true}
            aria-describedby={problem === null ? undefined : errorId}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
              mutation.reset();
            }}
          />
        </div>
        <Button type="submit" className={TOUCH} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save threshold'}
        </Button>
      </div>
      <p id={errorId} role="alert" className="min-h-5 text-sm text-loss">
        {problem ?? ''}
      </p>
    </form>
  );
}

export function FeeRuleTable({ rules }: { readonly rules: readonly FeeRuleVersion[] }) {
  return (
    <TableRegion label="Fee-rule versions">
      <table className="w-full min-w-xl border-y border-rule bg-surface text-left">
        <caption className="sr-only">Fee-rule versions shipped with BhavBook</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              Version
            </th>
            <th scope="col" className="px-3 font-medium">
              Covers
            </th>
            <th scope="col" className="px-3 font-medium">
              In force from
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Charges using it
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rules.map((rule) => (
            <tr key={rule.id} className="h-8">
              <th scope="row" className="px-3 font-mono text-[13px] font-normal">
                {rule.id}
              </th>
              <td className="px-3">{rule.kind === 'statutory' ? 'Exchange and taxes' : 'Broker plan'}</td>
              <td className="figure px-3">{formatIstDate(rule.effectiveFrom)}</td>
              <td className="figure px-3 text-right">{rule.charges.toLocaleString('en-IN')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}
