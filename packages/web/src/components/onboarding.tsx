// Onboarding forms (PRD §4): a profile, then a broker account. An account is a broker and a nickname: BhavBook never
// asks for a client ID, PAN or broker login, and says so where the question would come up.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type SyntheticEvent } from 'react';
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

function FieldError({ id, message }: { readonly id: string; readonly message: string | null }) {
  return (
    <p id={id} role={message === null ? undefined : 'alert'} className="min-h-5 text-sm text-loss">
      {message}
    </p>
  );
}

export function ProfileForm({ onCreated }: { readonly onCreated: (id: string) => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const fieldId = useId();
  const errorId = useId();
  const mutation = useMutation({
    mutationFn: createProfile,
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: profilesQuery.queryKey });
      onCreated(id);
    },
  });
  const error = mutation.isError ? saveError(mutation.error, 'profile') : null;
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate(name);
  };
  return (
    <form onSubmit={submit} className="max-w-md space-y-3" aria-labelledby={`${fieldId}-title`}>
      <h2 id={`${fieldId}-title`} className="text-base font-semibold">
        Name a profile
      </h2>
      <p className="text-ink-muted">
        A profile is how you review a style of trading, for example Swing or Long-term. Its accounts are
        reviewed together.
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Profile name</Label>
        <Input
          id={fieldId}
          value={name}
          maxLength={40}
          required
          autoComplete="off"
          aria-invalid={error !== null}
          aria-describedby={errorId}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <FieldError id={errorId} message={error} />
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Create profile'}
      </Button>
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

export interface AccountFormProps {
  readonly profiles: readonly Profile[];
  readonly onCreated: () => void;
}

export function AccountForm({ profiles, onCreated }: AccountFormProps) {
  const queryClient = useQueryClient();
  const [profileId, setProfileId] = useState(profiles.at(-1)?.id ?? '');
  const [broker, setBroker] = useState<BrokerId>('zerodha');
  const [nickname, setNickname] = useState('');
  const fieldId = useId();
  const errorId = useId();
  const mutation = useMutation({
    mutationFn: createAccount,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: profilesQuery.queryKey });
      onCreated();
    },
  });
  const error = mutation.isError ? saveError(mutation.error, 'account') : null;
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate({ profileId, broker, nickname });
  };
  return (
    <form onSubmit={submit} className="max-w-md space-y-4" aria-labelledby={`${fieldId}-title`}>
      <h2 id={`${fieldId}-title`} className="text-base font-semibold">
        Add a broker account
      </h2>
      <p className="text-ink-muted">
        A nickname is all BhavBook needs. It never asks for your client ID, PAN or broker login.
      </p>
      {profiles.length > 1 ? (
        <div className="space-y-1.5">
          <Label htmlFor={`${fieldId}-profile`}>Profile</Label>
          <select
            id={`${fieldId}-profile`}
            value={profileId}
            className="h-9 w-full rounded-md border border-input bg-surface px-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onChange={(event) => {
              setProfileId(event.target.value);
            }}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <BrokerChoice value={broker} onChange={setBroker} />
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Nickname</Label>
        <Input
          id={fieldId}
          value={nickname}
          maxLength={40}
          required
          autoComplete="off"
          placeholder="e.g. Zerodha main"
          aria-invalid={error !== null}
          aria-describedby={errorId}
          onChange={(event) => {
            setNickname(event.target.value);
          }}
        />
        <FieldError id={errorId} message={error} />
      </div>
      <Button type="submit" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Add account'}
      </Button>
    </form>
  );
}
