import { useQuery } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { AccountForm, ProfileForm } from '@/components/onboarding';
import { Disconnected, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { profilesQuery } from '@/lib/profiles';

export const Route = createFileRoute('/onboarding')({ component: Onboarding });

/** Which form is on screen, and whether it appeared after a user action (then it takes focus). */
interface Step {
  readonly form: 'auto' | 'profile' | 'account';
  readonly focus: boolean;
  readonly created?: string;
}

function StepLine({ step }: { readonly step: 1 | 2 }) {
  return (
    <p className="mt-2 text-ink-muted">
      Step {step} of 2:{' '}
      <span className="font-medium text-ink">{step === 1 ? 'Profile' : 'Broker account'}</span>
    </p>
  );
}

function Onboarding() {
  const profiles = useQuery(profilesQuery);
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>({ form: 'auto', focus: false });
  const disconnection = profiles.error instanceof ApiError ? profiles.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  const list = profiles.data ?? [];
  const showProfile = profiles.isSuccess && (list.length === 0 || step.form === 'profile');
  const showAccount = profiles.isSuccess && !showProfile;
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Set up BhavBook</h1>
        {profiles.isSuccess ? <StepLine step={showProfile ? 1 : 2} /> : null}
      </div>
      {profiles.isPending ? <LoadingRows label="Loading your profiles" rows={2} /> : null}
      {profiles.isError ? (
        <ErrorState
          message="Could not read your profiles."
          retrying={profiles.isFetching}
          onRetry={() => void profiles.refetch()}
        />
      ) : null}
      {showProfile ? (
        <ProfileForm
          focusOnShow={step.focus}
          onCreated={(id) => {
            setStep({ form: 'account', focus: true, created: id });
          }}
          onCancel={
            list.length === 0
              ? undefined
              : () => {
                  setStep({ form: 'account', focus: true });
                }
          }
        />
      ) : null}
      {showAccount ? (
        <div className="space-y-4">
          <AccountForm
            key={step.created ?? 'newest'}
            profiles={list}
            initialProfileId={step.created}
            focusOnShow={step.focus}
            onCreated={() => void navigate({ to: '/' })}
          />
          <Button
            variant="link"
            className="px-0 max-md:h-11"
            onClick={() => {
              setStep({ form: 'profile', focus: true });
            }}
          >
            Create another profile instead
          </Button>
        </div>
      ) : null}
    </div>
  );
}
