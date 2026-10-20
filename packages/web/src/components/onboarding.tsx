// Onboarding forms (PRD §4): a profile, then a broker account. An account is a broker and a nickname: BhavBook never
// asks for a client ID, PAN or broker login, says so where the question would come up, and refuses a nickname
// shaped like one. Keyboard-first (direction §5): a form that appears after an action takes focus on its heading;
// a failed save returns focus to the field; errors live in a region that is always present, so they are announced.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  BROKERS,
  createAccount,
  createProfile,
  profilesQuery,
  saveError,
  type BrokerId,
  type Profile,
} from '@/lib/profiles';

/** Phone layout: 44 px targets (direction §7). */
const TOUCH = 'max-md:h-11';

function FieldError({ id, message }: { readonly id: string; readonly message: string | null }) {
  return (
    <p id={id} role="alert" className="min-h-5 text-sm text-loss">
      {message ?? ''}
    </p>
  );
}

/** Focuses the form's heading when it appears after a user action, so the new step is announced. */
function useFocusOnShow<T extends HTMLElement>(enabled: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (enabled) ref.current?.focus();
  }, [enabled]);
  return ref;
}

export interface ProfileFormProps {
  readonly onCreated: (id: string) => void;
  /** Offered when the person already has a profile and can go back to adding an account. */
  readonly onCancel?: (() => void) | undefined;
  readonly focusOnShow?: boolean;
}

export function ProfileForm({ onCreated, onCancel, focusOnShow = false }: ProfileFormProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const fieldId = useId();
  const errorId = useId();
  const heading = useFocusOnShow<HTMLHeadingElement>(focusOnShow);
  const input = useRef<HTMLInputElement>(null);
  const mutation = useMutation({
    mutationFn: createProfile,
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: profilesQuery.queryKey });
      onCreated(id);
    },
    onError: () => input.current?.focus(),
  });
  const error = mutation.isError ? saveError(mutation.error, 'profile') : null;
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate(name);
  };
  return (
    <form onSubmit={submit} className="max-w-md space-y-3">
      <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
        Name a profile
      </h2>
      <p className="text-ink-muted">
        A profile is how you review a style of trading, for example Swing or Long-term. Its accounts are
        reviewed together.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Profile name</Label>
        <Input
          ref={input}
          id={fieldId}
          value={name}
          maxLength={40}
          required
          autoComplete="off"
          aria-invalid={error === null ? undefined : true}
          aria-describedby={errorId}
          onChange={(event) => {
            setName(event.target.value);
            mutation.reset();
          }}
        />
        <FieldError id={errorId} message={error} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" className={TOUCH} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Create profile'}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" variant="ghost" className={TOUCH} onClick={onCancel}>
            Back to the account
          </Button>
        )}
      </div>
    </form>
  );
}

function BrokerChoice({
  value,
  onChange,
}: {
  readonly value: BrokerId;
  readonly onChange: (id: BrokerId) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="mb-1.5 text-sm font-medium">Broker</legend>
      <div className="flex gap-2">
        {BROKERS.map((broker) => (
          <Label
            key={broker.id}
            className="h-11 cursor-pointer rounded-md border border-input bg-surface px-4 has-checked:border-primary has-checked:bg-accent has-checked:text-accent-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring"
          >
            <input
              type="radio"
              name="broker"
              value={broker.id}
              checked={value === broker.id}
              className="sr-only"
              onChange={() => {
                onChange(broker.id);
              }}
            />
            {broker.label}
          </Label>
        ))}
      </div>
    </fieldset>
  );
}

function ProfileSelect(props: {
  readonly profiles: readonly Profile[];
  readonly value: string;
  readonly onChange: (id: string) => void;
}) {
  const fieldId = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>Profile</Label>
      <select
        id={fieldId}
        value={props.value}
        className="h-11 w-full rounded-md border border-input bg-surface px-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-9"
        onChange={(event) => {
          props.onChange(event.target.value);
        }}
      >
        {props.profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export interface AccountFormProps {
  readonly profiles: readonly Profile[];
  /** The profile to add to by default (the one just created); otherwise the newest. */
  readonly initialProfileId?: string | undefined;
  readonly onCreated: () => void;
  readonly focusOnShow?: boolean;
}

export function AccountForm({
  profiles,
  initialProfileId,
  onCreated,
  focusOnShow = false,
}: AccountFormProps) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState(initialProfileId);
  const [broker, setBroker] = useState<BrokerId>('zerodha');
  const [nickname, setNickname] = useState('');
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const heading = useFocusOnShow<HTMLHeadingElement>(focusOnShow);
  const input = useRef<HTMLInputElement>(null);
  // The chosen profile, while it still exists; otherwise the newest (the list can change under the form).
  const profileId = profiles.some((profile) => profile.id === chosen) ? chosen : profiles.at(-1)?.id;
  const mutation = useMutation({
    mutationFn: createAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profilesQuery.queryKey });
      onCreated();
    },
    onError: () => input.current?.focus(),
  });
  const error = mutation.isError ? saveError(mutation.error, 'account') : null;
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (profileId !== undefined) mutation.mutate({ profileId, broker, nickname });
  };
  return (
    <form onSubmit={submit} className="max-w-md space-y-4">
      <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
        Add a broker account
      </h2>
      <p className="text-ink-muted">
        A nickname is all BhavBook needs. It never asks for your client ID, PAN or broker login.
      </p>
      {profiles.length > 1 && profileId !== undefined ? (
        <ProfileSelect profiles={profiles} value={profileId} onChange={setChosen} />
      ) : null}
      <BrokerChoice value={broker} onChange={setBroker} />
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Nickname</Label>
        <Input
          ref={input}
          id={fieldId}
          value={nickname}
          maxLength={40}
          required
          autoComplete="off"
          placeholder="e.g. Zerodha main"
          aria-invalid={error === null ? undefined : true}
          aria-describedby={`${hintId} ${errorId}`}
          onChange={(event) => {
            setNickname(event.target.value);
            mutation.reset();
          }}
        />
        <p id={hintId} className="text-sm text-ink-muted">
          A name you choose, not your client ID or PAN.
        </p>
        <FieldError id={errorId} message={error} />
      </div>
      <Button type="submit" className={TOUCH} disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Add account'}
      </Button>
    </form>
  );
}
