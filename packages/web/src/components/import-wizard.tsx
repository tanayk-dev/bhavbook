// The import wizard (PRD §5.1): choose or drop files → a preview per file (what it is, new and duplicate rows,
// skipped by reason, errors as line + code, the date range, warnings, the issue forecast) → import → summary.
// Nothing is written until Import; a file BhavBook can't place by itself gets a picker. File names are shown here
// only: the preview is matched to the chosen files by position, and names are never sent (ADR-0019).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type DragEvent } from 'react';
import { focusLater, TableRegion, TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { formatIstDate } from '@/lib/format';
import {
  commitPreview,
  importError,
  previewFiles,
  reportLabel,
  skipReason,
  type ChosenFile,
  type FilePreview,
  type Preview,
} from '@/lib/imports';
import { BROKERS } from '@/lib/profiles';

const brokerLabel = (id: string): string => BROKERS.find((broker) => broker.id === id)?.label ?? id;
const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count.toLocaleString('en-IN')} ${count === 1 ? one : many}`;

/** What a file is, or why it can't be imported, in one line. */
function fileStatus(file: FilePreview, accountBroker: string): string {
  switch (file.status) {
    case 'ready':
      return reportLabel(file.kind);
    case 'ambiguous':
      return 'BhavBook could not tell which report this is. Choose it below.';
    case 'rejected':
      return `${reportLabel(file.kind)}: ${file.message}`;
    case 'wrong_broker':
      return `A ${brokerLabel(file.broker)} file, but this is a ${brokerLabel(accountBroker)} account.`;
    case 'unrecognised':
      return 'Not a report BhavBook can read.';
    case 'unreadable':
      return file.reason === 'too_large'
        ? 'Too large to import.'
        : 'The file is damaged or not what it claims.';
  }
}

/** A report v1 deliberately leaves out is information, not an error; a file that can't be read is. */
const statusTone = (status: FilePreview['status']): string | undefined => {
  if (status === 'ready') return undefined;
  return status === 'rejected' || status === 'ambiguous' ? 'text-ink-muted' : 'text-loss';
};

function ReadyDetails({ file }: { readonly file: Extract<FilePreview, { status: 'ready' }> }) {
  const skipped = Object.entries(file.counts.skipped);
  const created = file.issueForecast.filter((entry) => entry.change === 'create').length;
  const resolved = file.issueForecast.length - created;
  const notes = [
    ...(skipped.length === 0
      ? []
      : [
          `Skipped: ${skipped.map(([reason, n]) => `${n.toLocaleString('en-IN')} ${skipReason(reason)}`).join(', ')}.`,
        ]),
    ...(file.warnings.includes('wrong_account')
      ? ["Few of these trades match what this account already has. Check it isn't someone else's file."]
      : []),
    ...(created > 0
      ? [`${plural(created, 'position')} would be incomplete (sells with no matching buy yet).`]
      : []),
    ...(resolved > 0 ? [`${plural(resolved, 'incomplete position')} would be completed.`] : []),
    ...(file.warnings.includes('forecast_unavailable') ? ['Could not forecast issues for this file.'] : []),
  ];
  if (notes.length === 0 && file.errors.length === 0) return null;
  return (
    <div className="space-y-1 text-sm">
      {notes.map((note) => (
        <p key={note} className={note.startsWith('Skipped') ? 'text-ink-muted' : 'text-attention'}>
          {note}
        </p>
      ))}
      {file.errors.length === 0 ? null : (
        <details>
          <summary className="cursor-pointer text-loss">
            {plural(file.counts.errors, 'row')} could not be read
          </summary>
          <ul className="figure mt-1 columns-2 text-ink-muted sm:columns-4">
            {file.errors.map((error) => (
              <li key={`${error.line}:${error.code}`}>
                Line {error.line}: {error.code.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

interface PreviewTableProps {
  readonly chosen: readonly ChosenFile[];
  readonly preview: Preview;
  readonly accountBroker: string;
  readonly onPick: (index: number, kind: string) => void;
}

function PreviewTable({ chosen, preview, accountBroker, onPick }: PreviewTableProps) {
  return (
    <TableRegion label="Preview">
      <table className="w-full min-w-3xl border-y border-rule bg-surface text-left">
        <caption className="sr-only">What each file would import</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              File
            </th>
            <th scope="col" className="px-3 font-medium">
              Report
            </th>
            <th scope="col" className="px-3 font-medium">
              Covers
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              New
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Already imported
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {preview.files.map((file) => {
            const name = chosen[file.index]?.file.name ?? `File ${String(file.index + 1)}`;
            const ready = file.status === 'ready' ? file : null;
            const fresh = ready === null ? null : ready.counts.rows.new + ready.counts.statements.new;
            const repeated =
              ready === null ? null : ready.counts.rows.duplicate + ready.counts.statements.duplicate;
            return (
              <tr key={file.index} className="align-top">
                <th scope="row" className="max-w-56 px-3 py-1.5 font-normal break-words">
                  {name}
                </th>
                <td className="space-y-1 px-3 py-1.5">
                  <p className={statusTone(file.status)}>{fileStatus(file, accountBroker)}</p>
                  {file.status === 'ambiguous' ? (
                    <KindPicker
                      name={name}
                      candidates={file.candidates}
                      onPick={(kind) => {
                        onPick(file.index, kind);
                      }}
                    />
                  ) : null}
                  {ready === null ? null : <ReadyDetails file={ready} />}
                </td>
                <td className="figure px-3 py-1.5 whitespace-nowrap">
                  {ready?.coverage == null
                    ? '—'
                    : `${formatIstDate(ready.coverage.from)} – ${formatIstDate(ready.coverage.to)}`}
                </td>
                <td className="figure px-3 py-1.5 text-right">{fresh?.toLocaleString('en-IN') ?? '—'}</td>
                <td className="figure px-3 py-1.5 text-right text-ink-muted">
                  {repeated?.toLocaleString('en-IN') ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableRegion>
  );
}

function KindPicker({
  name,
  candidates,
  onPick,
}: {
  readonly name: string;
  readonly candidates: readonly string[];
  readonly onPick: (kind: string) => void;
}) {
  const fieldId = useId();
  const [kind, setKind] = useState(candidates[0] ?? '');
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Label htmlFor={fieldId} className="sr-only">
        Which report is {name}?
      </Label>
      <select
        id={fieldId}
        value={kind}
        className="h-11 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-8"
        onChange={(event) => {
          setKind(event.target.value);
        }}
      >
        {candidates.map((candidate) => (
          <option key={candidate} value={candidate}>
            {reportLabel(candidate)}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        className={TOUCH}
        onClick={() => {
          onPick(kind);
        }}
      >
        Use this
      </Button>
    </span>
  );
}

const importable = (preview: Preview): { rows: number; statements: number } =>
  preview.files.reduce(
    (total, file) =>
      file.status === 'ready'
        ? {
            rows: total.rows + file.counts.rows.new,
            statements: total.statements + file.counts.statements.new,
          }
        : total,
    { rows: 0, statements: 0 },
  );

export interface ImportWizardProps {
  readonly account: { readonly id: string; readonly broker: string; readonly nickname: string };
  readonly announce: (message: string) => void;
}

/** Choose files, preview them, import. Keyed by account: switching accounts starts afresh. */
export function ImportWizard({ account, announce }: ImportWizardProps) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<readonly ChosenFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const previewing = useMutation({
    mutationFn: (files: readonly ChosenFile[]) => previewFiles(account.id, files),
    onSuccess: (result) => {
      if (result.token !== null) focusLater(importButton);
    },
  });
  const committing = useMutation({
    mutationFn: commitPreview,
    onSuccess: async (added) => {
      setChosen([]);
      previewing.reset();
      // Trades, positions, issues and coverage all changed.
      await queryClient.invalidateQueries();
      announce(
        `Imported ${plural(added.rows, 'new trade row')} and ${plural(added.statements, 'statement row')} into ${account.nickname}. Positions were recomputed.`,
      );
      focusLater(fileInput);
    },
  });
  const choose = (files: readonly File[]) => {
    if (files.length === 0) return;
    const next = files.map((file) => ({ file }));
    setChosen(next);
    committing.reset();
    previewing.mutate(next);
  };
  const pick = (index: number, kind: string) => {
    const next = chosen.map((entry, at) => (at === index ? { ...entry, kind } : entry));
    setChosen(next);
    previewing.mutate(next);
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    choose([...event.dataTransfer.files]);
  };
  const result = previewing.data;
  const totals = result === undefined ? null : importable(result);
  const busy = previewing.isPending || committing.isPending;
  const nothingNew = totals !== null && totals.rows + totals.statements === 0;
  return (
    <div className="space-y-4">
      <div
        className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-dashed px-4 py-5 ${dragging ? 'border-primary bg-accent' : 'border-rule bg-surface'}`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={drop}
      >
        <Label htmlFor={fileId}>Broker files</Label>
        <input
          ref={fileInput}
          id={fileId}
          type="file"
          multiple
          accept=".csv,.xlsx,.xls"
          disabled={busy}
          className="max-w-72 text-sm file:mr-2 file:rounded-md file:border file:border-input file:bg-surface file:px-2 file:py-1"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            event.target.value = '';
            choose(files);
          }}
        />
        <p className="text-sm text-ink-muted">
          or drop them here. Up to 10 at a time; nothing is imported until you confirm.
        </p>
      </div>
      {previewing.isPending ? (
        <p role="status" className="text-ink-muted">
          Reading {plural(chosen.length, 'file')}…
        </p>
      ) : null}
      {previewing.isError ? (
        <p role="alert" className="text-loss">
          {importError(previewing.error)}
        </p>
      ) : null}
      {result === undefined || totals === null ? null : (
        <>
          <PreviewTable chosen={chosen} preview={result} accountBroker={account.broker} onPick={pick} />
          <div className="flex flex-wrap items-center gap-3">
            <Button
              ref={importButton}
              className={TOUCH}
              disabled={result.token === null || nothingNew || busy}
              onClick={() => {
                if (result.token !== null) committing.mutate(result.token);
              }}
            >
              {committing.isPending
                ? 'Importing…'
                : `Import ${plural(totals.rows, 'new trade row')}${totals.statements > 0 ? ` and ${plural(totals.statements, 'statement row')}` : ''}`}
            </Button>
            <Button
              variant="ghost"
              className={TOUCH}
              disabled={busy}
              onClick={() => {
                setChosen([]);
                previewing.reset();
                focusLater(fileInput);
              }}
            >
              Start over
            </Button>
            <p className="text-sm text-ink-muted">
              {result.token === null
                ? 'None of these files can be imported into this account.'
                : nothingNew
                  ? 'Everything in these files is already imported.'
                  : 'A backup is made first, and any import can be undone below.'}
            </p>
          </div>
          {committing.isError ? (
            <p role="alert" className="text-loss">
              {importError(committing.error)}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
