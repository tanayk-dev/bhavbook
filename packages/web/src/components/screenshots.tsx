// Screenshots on a journal entry (PRD §3.3, ADR-0020): paste, drop or pick images. Each is re-encoded to WebP in the
// browser (only pixels survive: EXIF and location never leave the page) within 1 MB, then stored; the server checks
// both again. An entry that does not exist yet is created first (an empty one, filled in later).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import {
  deleteScreenshot,
  saveJournal,
  screenshotError,
  screenshotUrl,
  toWebp,
  uploadScreenshot,
} from '@/lib/journal';
import type { JournalEntry } from '@/lib/positions';

const EMPTY_ENTRY = {
  setupTagId: null,
  mistakeTagIds: [],
  thesis: null,
  initialStopMicro: null,
  plannedStopMicro: null,
  plannedTargetMicro: null,
  plannedRiskMicro: null,
  reviewNote: null,
} as const;

const images = (files: Iterable<File>): File[] => [...files].filter((file) => file.type.startsWith('image/'));

export interface ScreenshotsProps {
  readonly positionRef: string;
  /** The entry they belong to; null until the position's journal is first saved. */
  readonly entry: JournalEntry | null;
}

export function Screenshots({ positionRef, entry }: ScreenshotsProps) {
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const zoneHint = useId();
  const add = useMutation({
    mutationFn: async (files: File[]) => {
      // An entry is needed first; the empty one carries nothing the form has not saved.
      const entryId = entry?.id ?? (await saveJournal(positionRef, EMPTY_ENTRY));
      for (const file of files) await uploadScreenshot(entryId, await toWebp(file));
      return files.length;
    },
    onSuccess: async (count) => {
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      setMessage(count === 1 ? 'Added the screenshot.' : `Added ${String(count)} screenshots.`);
    },
    onError: async (error) => {
      setProblem(screenshotError(error));
      // Some may have been stored before one failed.
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
    },
  });
  const remove = useMutation({
    mutationFn: deleteScreenshot,
    onSuccess: async () => {
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      setMessage('Deleted the screenshot.');
    },
    onError: (error) => {
      setProblem(screenshotError(error));
    },
  });
  const take = (files: File[]) => {
    setProblem(null);
    setMessage('');
    if (files.length === 0) {
      setProblem('Only images can be added.');
      return;
    }
    add.mutate(files);
  };
  const onPaste = (event: ClipboardEvent) => {
    const pasted = images(event.clipboardData.files);
    if (pasted.length === 0) return;
    event.preventDefault();
    take(pasted);
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    take(images(event.dataTransfer.files));
  };
  const attachments = entry?.attachments ?? [];
  return (
    <section aria-labelledby="screenshots" className="space-y-3">
      <h3 id="screenshots" className="font-semibold">
        Screenshots
      </h3>
      {attachments.length === 0 ? null : (
        <ul className="flex flex-wrap gap-3">
          {attachments.map((attachment, index) => (
            <li key={attachment.id} className="space-y-1">
              <a href={screenshotUrl(attachment.id)} target="_blank" rel="noopener noreferrer">
                <img
                  src={screenshotUrl(attachment.id)}
                  alt={`Screenshot ${String(index + 1)}`}
                  className="h-28 w-auto rounded-sm border border-rule object-contain"
                />
              </a>
              {confirming === attachment.id ? (
                <div className="flex gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      remove.mutate(attachment.id);
                    }}
                  >
                    Delete it
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setConfirming(null);
                    }}
                  >
                    Keep
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Delete screenshot ${String(index + 1)}`}
                  onClick={() => {
                    setConfirming(attachment.id);
                  }}
                >
                  Delete
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div
        role="group"
        tabIndex={0}
        aria-label="Add screenshots"
        aria-describedby={zoneHint}
        onPaste={onPaste}
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={onDrop}
        className="flex max-w-3xl flex-wrap items-center gap-3 rounded-md border border-dashed border-rule px-4 py-3 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        <Button
          type="button"
          variant="outline"
          className={TOUCH}
          disabled={add.isPending}
          onClick={() => {
            picker.current?.click();
          }}
        >
          {add.isPending ? 'Adding…' : 'Add screenshots…'}
        </Button>
        <p id={zoneHint} className="text-sm text-ink-muted">
          Or paste (focus here, then Ctrl+V) or drop images. They are converted to WebP in your browser, which
          drops location and camera details, and kept under 1 MB each.
        </p>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Screenshot files"
          onChange={(event) => {
            take(images(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      </div>
      <p role="alert" className="text-sm text-loss">
        {problem ?? ''}
      </p>
      <p role="status" className="text-sm">
        {message}
      </p>
    </section>
  );
}
