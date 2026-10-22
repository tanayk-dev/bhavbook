import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useRef, useState, type ReactNode } from 'react';
import { BreakevenForm, FeeRuleTable, InlineRename, MoveAccount, TableRegion } from '@/components/settings';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { BackupsPanel } from '@/components/backups';
import { TagTable } from '@/components/tags';
import { ApiError } from '@/lib/api';
import { BROKERS, profilesQuery, type Profile } from '@/lib/profiles';
import { renameAccount, renameProfile, settingsQuery } from '@/lib/settings';
import { backupsQuery } from '@/lib/backups';
import { tagsQuery } from '@/lib/tags';

export const Route = createFileRoute('/settings')({ component: SettingsPage });

const brokerLabel = (id: string): string => BROKERS.find((broker) => broker.id === id)?.label ?? id;
const LINK = 'text-primary underline-offset-4 hover:underline';
const ANNOUNCE_DELAY_MS = 50;

/**
 * One status line for the page's results. It is cleared and set again on each message, so a repeated message
 * (the same move twice, a second save) is announced again.
 */
function useAnnouncer(): [string, (message: string) => void] {
  const [message, setMessage] = useState('');
  const timer = useRef<number | undefined>(undefined);
  const announce = (next: string) => {
    window.clearTimeout(timer.current);
    setMessage('');
    timer.current = window.setTimeout(() => {
      setMessage(next);
    }, ANNOUNCE_DELAY_MS);
  };
  return [message, announce];
}

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

interface TableProps {
  readonly profiles: readonly Profile[];
  readonly announce: (message: string) => void;
}

function ProfilesTable({ profiles, announce }: TableProps) {
  return (
    <TableRegion label="Profiles">
      <table className="w-full min-w-md border-y border-rule bg-surface text-left">
        <caption className="sr-only">Profiles</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              Profile
            </th>
            <th scope="col" className="w-28 px-3 text-right font-medium">
              Accounts
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {profiles.map((profile) => (
            <tr key={profile.id}>
              <th scope="row" className="px-3 font-normal">
                <InlineRename
                  what="profile name"
                  kind="profile"
                  value={profile.name}
                  save={(name) => renameProfile(profile.id, name)}
                  onSaved={(name) => {
                    announce(`Renamed the profile to ${name}.`);
                  }}
                />
              </th>
              <td className="figure px-3 text-right">{profile.accounts.length}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

function AccountsTable({ profiles, announce }: TableProps) {
  const rows = profiles.flatMap((profile) => profile.accounts.map((account) => ({ profile, account })));
  if (rows.length === 0) {
    return (
      <p className="text-ink-muted">
        No broker accounts yet.{' '}
        <Link to="/onboarding" className={LINK}>
          Add one
        </Link>
        .
      </p>
    );
  }
  return (
    <TableRegion label="Broker accounts">
      <table className="w-full min-w-3xl border-y border-rule bg-surface text-left">
        <caption className="sr-only">Broker accounts</caption>
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
              <th scope="row" className="px-3 font-normal">
                <InlineRename
                  what="nickname"
                  kind="account"
                  value={account.nickname}
                  save={(nickname) => renameAccount(account.id, nickname)}
                  onSaved={(nickname) => {
                    announce(`Renamed the account to ${nickname}.`);
                  }}
                />
              </th>
              <td className="px-3 pt-1.5">{brokerLabel(account.broker)}</td>
              <td className="px-3 pt-1.5 text-ink-muted">{profile.name}</td>
              <td className="px-3 py-1">
                <MoveAccount account={account} from={profile} profiles={profiles} onMoved={announce} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

function ProfileSections(props: TableProps) {
  if (props.profiles.length === 0) {
    return (
      <EmptyState title="No profiles yet">
        <Link to="/onboarding" className={LINK}>
          Set up a profile and a broker account
        </Link>{' '}
        first; they can be renamed and moved here.
      </EmptyState>
    );
  }
  return (
    <>
      <Section id="profiles-title" title="Profiles">
        <ProfilesTable {...props} />
      </Section>
      <Section id="accounts-title" title="Broker accounts">
        <p className="text-ink-muted">Moving an account to another profile recomputes its positions.</p>
        <AccountsTable {...props} />
      </Section>
    </>
  );
}

function SettingsPage() {
  const profiles = useQuery(profilesQuery);
  const settings = useQuery(settingsQuery);
  const tags = useQuery(tagsQuery);
  const backups = useQuery(backupsQuery);
  const [notice, announce] = useAnnouncer();
  const failure = profiles.error ?? settings.error ?? tags.error ?? backups.error;
  const disconnection = failure instanceof ApiError ? failure.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  return (
    <div className="max-w-5xl space-y-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h1 className="text-lg font-semibold">Settings</h1>
        <p role="status" className="text-sm">
          {notice}
        </p>
      </div>
      {profiles.isPending || settings.isPending || tags.isPending || backups.isPending ? (
        <LoadingRows label="Loading settings" rows={4} />
      ) : null}
      {failure === null ? null : (
        <ErrorState
          message="Could not read the settings."
          retrying={profiles.isFetching || settings.isFetching || tags.isFetching || backups.isFetching}
          onRetry={() => {
            void profiles.refetch();
            void settings.refetch();
            void tags.refetch();
            void backups.refetch();
          }}
        />
      )}
      {profiles.isSuccess ? <ProfileSections profiles={profiles.data} announce={announce} /> : null}
      {tags.isSuccess ? (
        <Section id="tags-title" title="Tags">
          <p className="text-ink-muted">
            A setup tag says why you took a trade; mistake tags mark what went wrong. You attach them in the
            journal. Merging or deleting a tag never deletes a journal entry.
          </p>
          <TagTable kind="setup" tags={tags.data} announce={announce} />
          <TagTable kind="mistake" tags={tags.data} announce={announce} />
        </Section>
      ) : null}
      {settings.isSuccess ? (
        <>
          <Section id="breakeven-title" title="Breakeven threshold">
            <BreakevenForm currentMicro={settings.data.breakevenThresholdMicro} onSaved={announce} />
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
      {backups.isSuccess ? (
        <Section id="backups-title" title="Backups">
          <p className="text-ink-muted">
            Backups are saved next to your vault. Download one to keep a copy elsewhere.
          </p>
          <BackupsPanel backups={backups.data} announce={announce} />
        </Section>
      ) : null}
      <Section id="diagnostics-title" title="Diagnostics">
        <p className="text-ink-muted">
          For a bug report: counts, versions and the shape of each imported file&apos;s rows (how many
          columns, and whether each holds a number, a date or text). It never contains a value, a name, a file
          name or an id.
        </p>
        <a
          href="/api/diagnostics"
          download="bhavbook-diagnostics.json"
          className="inline-flex h-11 items-center rounded-md border border-input px-3 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden md:h-9"
        >
          Download diagnostics
        </a>
      </Section>
    </div>
  );
}
