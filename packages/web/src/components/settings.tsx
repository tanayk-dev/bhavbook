// Settings building blocks (PRD §4): inline rename, the confirm-then-move of an account (PRD §2 C5: a move
// recomputes the account), the breakeven threshold, and the read-only fee-rule versions.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { Money } from '@/components/money';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatIstDate } from '@/lib/format';
import { profilesQuery, saveError, type Profile } from '@/lib/profiles';
import { moveAccount, saveBreakeven, settingsQuery, type FeeRuleVersion } from '@/lib/settings';

const TOUCH = 'max-md:h-11';

export interface InlineRenameProps {
  /** What is being renamed, for the field's label ("profile name", "nickname"). */
  readonly what: string;
  readonly value: string;
  readonly kind: 'profile' | 'account';
  readonly save: (value: string) => Promise<void>;
}

/** A name with a Rename button that turns into a small form; Escape cancels and focus returns to the button. */
export function InlineRename({ what, value, kind, save }: InlineRenameProps) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const fieldId = useId();
  const errorId = useId();
  const input = useRef<HTMLInputElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const mutation = useMutation({
    mutationFn: save,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profilesQuery.queryKey });
      setEditing(false);
    },
    onError: () => input.current?.focus(),
  });
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);
  const close = () => {
    setEditing(false);
    mutation.reset();
    requestAnimationFrame(() => button.current?.focus());
  };
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
    mutation.mutate(draft);
  };
  const error = mutation.isError ? saveError(mutation.error, kind) : null;
  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap items-start gap-2 py-1"
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
      }}
    >
      <Label htmlFor={fieldId} className="sr-only">
        New {what}
      </Label>
      <div className="min-w-48 flex-1">
        <Input
          ref={input}
          id={fieldId}
          value={draft}
          maxLength={40}
          required
          autoComplete="off"
          aria-invalid={error === null ? undefined : true}
          aria-describedby={errorId}
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
      <Button type="button" variant="ghost" size="sm" className={TOUCH} onClick={close}>
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

/** Pick another profile, then confirm: the move recomputes the account's positions (PRD §2 C5). */
export function MoveAccount({ account, from, profiles, onMoved }: MoveAccountProps) {
  const queryClient = useQueryClient();
  const targets = profiles.filter((profile) => profile.id !== from.id);
  const [chosen, setChosen] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const fieldId = useId();
  // The chosen target while it is still another profile; otherwise the first one (the list changes after a move).
  const target = targets.find((profile) => profile.id === chosen) ?? targets[0];
  const mutation = useMutation({
    mutationFn: (to: { readonly id: string; readonly name: string }) => moveAccount(account.id, to.id),
    onSuccess: async (recomputed, to) => {
      setConfirming(false);
      setChosen(undefined);
      await queryClient.invalidateQueries({ queryKey: profilesQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
      onMoved(`Moved ${account.nickname} to ${to.name} and recomputed ${String(recomputed)} positions.`);
    },
  });
  if (target === undefined) return <span className="text-ink-muted">Create another profile to move it.</span>;
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
            size="sm"
            className={TOUCH}
            disabled={mutation.isPending}
            onClick={() => {
              mutation.mutate({ id: target.id, name: target.name });
            }}
          >
            {mutation.isPending ? 'Moving…' : 'Move and recompute'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={TOUCH}
            onClick={() => {
              setConfirming(false);
            }}
          >
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
        }}
      >
        {targets.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
      <Button
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

const BREAKEVEN_ERROR = 'Enter rupees with up to two decimals, for example 10 or 12.50.';

export function BreakevenForm({ currentMicro }: { readonly currentMicro: bigint }) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const fieldId = useId();
  const noteId = useId();
  const mutation = useMutation({
    mutationFn: saveBreakeven,
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: settingsQuery.queryKey });
    },
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate(draft.trim());
  };
  return (
    <form onSubmit={submit} className="max-w-md space-y-2">
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
            required
            autoComplete="off"
            aria-invalid={mutation.isError ? true : undefined}
            aria-describedby={noteId}
            onChange={(event) => {
              setDraft(event.target.value);
              mutation.reset();
            }}
          />
        </div>
        <Button type="submit" className={TOUCH} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
      <p id={noteId} role="status" className="min-h-5 text-sm">
        {mutation.isError ? (
          <span className="text-loss">{BREAKEVEN_ERROR}</span>
        ) : mutation.isSuccess ? (
          'Saved.'
        ) : (
          ''
        )}
      </p>
    </form>
  );
}

export function FeeRuleTable({ rules }: { readonly rules: readonly FeeRuleVersion[] }) {
  return (
    <table className="w-full border-y border-rule bg-surface text-left">
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
            <td className="px-3 font-mono text-[13px]">{rule.id}</td>
            <td className="px-3">{rule.kind === 'statutory' ? 'Exchange and taxes' : 'Broker plan'}</td>
            <td className="figure px-3">{formatIstDate(rule.effectiveFrom)}</td>
            <td className="figure px-3 text-right">{rule.charges.toLocaleString('en-IN')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
