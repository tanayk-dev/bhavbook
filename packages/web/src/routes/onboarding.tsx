import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountForm, ProfileForm } from '@/components/onboarding';
import { Disconnected, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { profilesQuery } from '@/lib/profiles';

export const Route = createFileRoute('/onboarding')({ component: Onboarding });

function Onboarding() {
  const profiles = useQuery(profilesQuery);
  const navigate = useNavigate();
  const [newProfile, setNewProfile] = useState(false);
  const disconnection = profiles.error instanceof ApiError ? profiles.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  const hasProfile = profiles.isSuccess && profiles.data.length > 0;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Set up BhavBook</h1>
        <ol className="mt-2 flex gap-4 text-ink-muted" aria-label="Steps">
          <li
            aria-current={hasProfile ? undefined : 'step'}
            className={hasProfile ? '' : 'font-medium text-ink'}
          >
            1. Profile
          </li>
          <li
            aria-current={hasProfile ? 'step' : undefined}
            className={hasProfile ? 'font-medium text-ink' : ''}
          >
            2. Broker account
          </li>
        </ol>
      </div>
      {profiles.isPending ? <LoadingRows label="Loading your profiles" rows={2} /> : null}
      {profiles.isError ? (
        <ErrorState
          message="Could not read your profiles."
          retrying={profiles.isFetching}
          onRetry={() => void profiles.refetch()}
        />
      ) : null}
      {profiles.isSuccess && (!hasProfile || newProfile) ? (
        <ProfileForm
          onCreated={() => {
            setNewProfile(false);
          }}
        />
      ) : null}
      {hasProfile && !newProfile ? (
        <div className="space-y-4">
          <AccountForm profiles={profiles.data} onCreated={() => void navigate({ to: '/' })} />
          <Button
            variant="link"
            className="px-0"
            onClick={() => {
              setNewProfile(true);
            }}
          >
            Create another profile instead
          </Button>
        </div>
      ) : null}
    </div>
  );
}
