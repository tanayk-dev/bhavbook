import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { BreakevenForm, FeeRuleTable, InlineRename, MoveAccount } from '@/components/settings';
import { Disconnected, ErrorState, LoadingRows } from '@/components/states';
import { ApiError } from '@/lib/api';
import { BROKERS, profilesQuery, type Profile } from '@/lib/profiles';
import { renameAccount, renameProfile, settingsQuery } from '@/lib/settings';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

const brokerLabel = (id: string): string => BROKERS.find((broker) => broker.id === id)?.label ?? id;

function Section({
  id,
  title,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ProfilesTable({ profiles }: { readonly profiles: readonly Profile[] }) {
  return (
    <table className="w-full border-y border-rule bg-surface text-left">
      <thead className="text-ink-muted">
        <tr className="h-8 border-b border-rule">
          <th scope="col" className="px-3 font-medium">
            Profile
          </th>
          <th scope="col" className="w-32 px-3 text-right font-medium">
            Accounts
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-rule">
        {profiles.map((profile) => (
          <tr key={profile.id}>
            <td className="px-3">
              <InlineRename
                what="profile name"
                kind="profile"
                value={profile.name}
                save={(name) => renameProfile(profile.id, name)}
              />
            </td>
            <td className="figure px-3 text-right">{profile.accounts.length}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function AccountsTable({
  profiles,
  onMoved,
}: {
  readonly profiles: readonly Profile[];
  readonly onMoved: (message: string) => void;
}) {
  const rows = profiles.flatMap((profile) => profile.accounts.map((account) => ({ profile, account })));
  if (rows.length === 0) return <p className="text-ink-muted">No broker accounts yet.</p>;
  return (
    <table className="w-full border-y border-rule bg-surface text-left">
      <thead className="text-ink-muted">
        <tr className="h-8 border-b border-rule">
          <th scope="col" className="px-3 font-medium">
            Account
          </th>
          <th scope="col" className="px-3 font-medium">
            Broker
          </th>
          <th scope="col" className="px-3 font-medium">
            Profile
          </th>
          <th scope="col" className="px-3 font-medium">
            Move to
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-rule">
        {rows.map(({ profile, account }) => (
          <tr key={account.id} className="align-top">
            <td className="px-3">
              <InlineRename
                what="nickname"
                kind="account"
                value={account.nickname}
                save={(nickname) => renameAccount(account.id, nickname)}
              />
            </td>
            <td className="px-3 pt-1.5">{brokerLabel(account.broker)}</td>
            <td className="px-3 pt-1.5 text-ink-muted">{profile.name}</td>
            <td className="px-3 py-1">
              <MoveAccount account={account} from={profile} profiles={profiles} onMoved={onMoved} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SettingsPage() {
  const profiles = useQuery(profilesQuery);
  const settings = useQuery(settingsQuery);
  const [notice, setNotice] = useState('');
  const failure = profiles.error ?? settings.error;
  const disconnection = failure instanceof ApiError ? failure.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  return (
    <div className="max-w-5xl space-y-8">
      <h1 className="text-lg font-semibold">Settings</h1>
      {profiles.isPending || settings.isPending ? <LoadingRows label="Loading settings" rows={4} /> : null}
      {failure === null ? null : (
        <ErrorState
          message="Could not read the settings."
          retrying={profiles.isFetching || settings.isFetching}
          onRetry={() => {
            void profiles.refetch();
            void settings.refetch();
          }}
        />
      )}
      {profiles.isSuccess ? (
        <>
          <Section id="profiles-title" title="Profiles">
            <ProfilesTable profiles={profiles.data} />
          </Section>
          <Section id="accounts-title" title="Broker accounts">
            <p className="text-ink-muted">Moving an account to another profile recomputes its positions.</p>
            <AccountsTable profiles={profiles.data} onMoved={setNotice} />
            <p role="status" className="text-sm">
              {notice}
            </p>
          </Section>
        </>
      ) : null}
      {settings.isSuccess ? (
        <>
          <Section id="breakeven-title" title="Breakeven threshold">
            <BreakevenForm currentMicro={settings.data.breakevenThresholdMicro} />
          </Section>
          <Section id="fees-title" title="Fee rules">
            <p className="text-ink-muted">
              Charges are estimated with the version in force on each trade date. These ship with BhavBook and
              cannot be edited here.
            </p>
            <FeeRuleTable rules={settings.data.feeRules} />
          </Section>
        </>
      ) : null}
    </div>
  );
}
