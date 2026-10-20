// Backups in settings (PRD §4, ADR-0020): back up now, the list of manual and automatic backups with download and
// restore, and restore from a `.bhav` file. A restore replaces everything, so it always confirms first and says
// that the current vault is backed up before it is replaced. Afterwards every query is refetched: all data changed.
import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { focusLater, TableRegion, TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  backUpNow,
  backupReason,
  backupsQuery,
  downloadUrl,
  formatBytes,
  restoreBackup,
  restoreError,
  restoreFile,
  type Backup,
} from '@/lib/backups';
import { ApiError } from '@/lib/api';
import { formatIstDateTime } from '@/lib/format';

type Picked =
  { readonly kind: 'listed'; readonly backup: Backup } | { readonly kind: 'file'; readonly file: File };

/** What to restore; `selection` makes each pick a fresh confirm, even of a same-named file. */
type Source = Picked & { readonly selection: number };

const RESTORE_KEY = ['restore'] as const;

const LINK =
  'inline-flex items-center rounded-sm px-2 text-primary underline-offset-4 hover:underline max-md:h-11';

const describe = (source: Source): string =>
  // A picked file's name is shown in this session only, never sent or stored (ADR-0019).
  source.kind === 'listed'
    ? `the backup from ${formatIstDateTime(source.backup.createdAt)}`
    : `the file ${source.file.name}`;

interface ConfirmRestoreProps {
  readonly source: Source;
  readonly onCancel: () => void;
  readonly onRestored: (message: string) => void;
}

function ConfirmRestore({ source, onCancel, onRestored }: ConfirmRestoreProps) {
  const queryClient = useQueryClient();
  const confirmButton = useRef<HTMLButtonElement>(null);
  const questionId = useId();
  const mutation = useMutation({
    mutationKey: RESTORE_KEY,
    mutationFn: () =>
      source.kind === 'listed' ? restoreBackup(source.backup.name) : restoreFile(source.file),
    onSuccess: async () => {
      // Everything on every page may have changed: drop what no page shows now, refetch what they do.
      queryClient.removeQueries({ type: 'inactive' });
      await queryClient.invalidateQueries();
      onRestored(`Restored ${describe(source)}.`);
    },
    // The button was disabled while the request ran, which dropped focus: put it back for a retry.
    onError: () => {
      focusLater(confirmButton);
    },
  });
  useEffect(() => {
    confirmButton.current?.focus();
  }, []);
  return (
    <div
      role="group"
      aria-label="Confirm restore"
      className="max-w-2xl space-y-2 border-l-2 border-loss bg-surface px-3 py-2"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !mutation.isPending) onCancel();
      }}
    >
      <p id={questionId} className="break-words">
        Replace everything in BhavBook with {describe(source)}? Your current data is backed up first, so you
        can restore it again from this list.
      </p>
      {mutation.isError ? (
        <p role="alert" className="text-sm text-loss">
          {restoreError(mutation.error)}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          ref={confirmButton}
          aria-describedby={questionId}
          size="sm"
          variant="destructive"
          className={TOUCH}
          disabled={mutation.isPending}
          onClick={() => {
            mutation.mutate();
          }}
        >
          {mutation.isPending ? 'Restoring…' : 'Restore'}
        </Button>
        <Button variant="ghost" size="sm" className={TOUCH} disabled={mutation.isPending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BackupTable({
  backups,
  disabled,
  onRestore,
}: {
  readonly backups: readonly Backup[];
  /** While a restore runs, no other may start. */
  readonly disabled: boolean;
  readonly onRestore: (backup: Backup) => void;
}) {
  if (backups.length === 0) {
    return (
      <p className="text-ink-muted">No backups yet. BhavBook also makes one before every import and undo.</p>
    );
  }
  return (
    <TableRegion label="Backup list">
      <table className="w-full min-w-xl border-y border-rule bg-surface text-left">
        <caption className="sr-only">Backups, newest first</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              Made
            </th>
            <th scope="col" className="px-3 font-medium">
              Why
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Size
            </th>
            <th scope="col" className="px-3 font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {backups.map((entry) => {
            const when = formatIstDateTime(entry.createdAt);
            return (
              <tr key={entry.name} className="h-9">
                <th scope="row" className="figure px-3 font-normal">
                  {when}
                </th>
                <td className="px-3">{backupReason(entry.reason)}</td>
                <td className="figure px-3 text-right">{formatBytes(entry.bytes)}</td>
                <td className="px-3">
                  <span className="flex justify-end gap-1">
                    <a
                      href={downloadUrl(entry.name)}
                      download
                      className={LINK}
                      aria-label={`Download the backup from ${when}`}
                    >
                      Download
                    </a>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={TOUCH}
                      aria-label={`Restore the backup from ${when}…`}
                      disabled={disabled}
                      onClick={() => {
                        onRestore(entry);
                      }}
                    >
                      Restore…
                    </Button>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableRegion>
  );
}

export interface BackupsPanelProps {
  readonly backups: readonly Backup[];
  readonly announce: (message: string) => void;
}

export function BackupsPanel({ backups, announce }: BackupsPanelProps) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Source | null>(null);
  const selections = useRef(0);
  const restoring = useIsMutating({ mutationKey: RESTORE_KEY }) > 0;
  const fileId = useId();
  const backUpButton = useRef<HTMLButtonElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const backUp = useMutation({
    mutationFn: backUpNow,
    onSuccess: async (made) => {
      await queryClient.invalidateQueries({ queryKey: backupsQuery.queryKey });
      announce(`Backed up BhavBook (${formatBytes(made.bytes)}).`);
    },
  });
  const pick = (source: Picked) => {
    selections.current += 1;
    setPending({ ...source, selection: selections.current });
  };
  const close = () => {
    focusLater(pending?.kind === 'file' ? fileInput : backUpButton);
    setPending(null);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <Button
          ref={backUpButton}
          className={TOUCH}
          disabled={backUp.isPending || restoring}
          onClick={() => {
            backUp.mutate();
          }}
        >
          {backUp.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
        <div className="flex items-center gap-2">
          <Label htmlFor={fileId}>Restore from a file</Label>
          <input
            ref={fileInput}
            id={fileId}
            type="file"
            accept=".bhav"
            disabled={restoring}
            className="max-w-56 text-sm file:mr-2 file:rounded-md file:border file:border-input file:bg-surface file:px-2 file:py-1"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file !== undefined) pick({ kind: 'file', file });
            }}
          />
        </div>
      </div>
      {backUp.isError ? (
        <p role="alert" className="text-sm text-loss">
          {backUp.error instanceof ApiError && backUp.error.status === 200
            ? 'The backup may have been made, but its details could not be read. Reload the page to check.'
            : 'Could not make a backup. Check that the disk has space, then try again.'}
        </p>
      ) : null}
      {pending === null ? null : (
        <ConfirmRestore
          key={pending.selection}
          source={pending}
          onCancel={close}
          onRestored={(message) => {
            announce(message);
            close();
          }}
        />
      )}
      <BackupTable
        backups={backups}
        disabled={restoring}
        onRestore={(entry) => {
          pick({ kind: 'listed', backup: entry });
        }}
      />
    </div>
  );
}
