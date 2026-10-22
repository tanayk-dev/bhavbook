// Screenshots on a journal entry (PRD §3.3, ADR-0020): paste (anywhere on the page), drop or pick images. Each is
// re-encoded to WebP in the browser first (only pixels survive: EXIF and location never leave the page) within 1 MB,
// then the entry is made sure of (created empty if there is none, an existing one never changed) and they are
// stored; the server checks everything again. One batch at a time.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import {
  deleteScreenshot,
  ensureEntry,
  screenshotError,
  screenshotUrl,
  toWebp,
  uploadScreenshot,
} from '@/lib/journal';
import type { JournalEntry } from '@/lib/positions';

const isImage = (file: File): boolean => file.type.startsWith('image/');

export interface ScreenshotsProps {
  readonly positionRef: string;
  /** The entry they belong to; null until the position's journal exists. */
  readonly entry: JournalEntry | null;
}

export function Screenshots({ positionRef, entry }: ScreenshotsProps) {
  const queryClient = useQueryClient();
  const picker = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const keep = useRef<HTMLButtonElement>(null);
  const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const zoneHint = useId();
  const add = useMutation({
    mutationFn: async (files: File[]) => {
      // Convert everything first: a file that cannot be converted leaves no empty entry behind.
      const converted: Blob[] = [];
      for (const file of files) converted.push(await toWebp(file));
      const entryId = entry?.id ?? (await ensureEntry(positionRef));
      for (const webp of converted) await uploadScreenshot(entryId, webp);
      return converted.length;
    },
    onSuccess: async (count) => {
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      setMessage((current) =>
        `${count === 1 ? 'Added the screenshot.' : `Added ${String(count)} screenshots.`} ${current}`.trim(),
      );
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
      heading.current?.focus();
    },
    onError: (error) => {
      setConfirming(null);
      setProblem(screenshotError(error));
    },
  });
  const take = (files: readonly File[]) => {
    if (add.isPending) return;
    setProblem(null);
    const kept = files.filter(isImage);
    const skipped = files.length - kept.length;
    setMessage(
      skipped === 0
        ? ''
        : `Skipped ${String(skipped)} ${skipped === 1 ? 'file that is not an image' : 'files that are not images'}.`,
    );
    if (kept.length === 0) {
      setProblem('Only images can be added.');
      return;
    }
    add.mutate(kept);
  };
  const takeRef = useRef(take);
  useEffect(() => {
    takeRef.current = take;
  });

  // Paste works anywhere on the page: a pasted picture (not text) becomes a screenshot.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])].filter(isImage);
      if (files.length === 0) return;
      event.preventDefault();
      takeRef.current(files);
    };
    // A file dropped outside the drop area would make the browser navigate to it, leaving the page.
    const guard = (event: globalThis.DragEvent) => {
      if (event.dataTransfer?.types.includes('Files') === true) event.preventDefault();
    };
    document.addEventListener('paste', onPaste);
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  useEffect(() => {
    if (confirming !== null) keep.current?.focus();
  }, [confirming]);

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    take([...event.dataTransfer.files]);
  };
  const attachments = entry?.attachments ?? [];
  return (
    <section aria-labelledby="screenshots" className="space-y-3">
      <h3 id="screenshots" ref={heading} tabIndex={-1} className="font-semibold focus:outline-hidden">
        Screenshots
      </h3>
      {attachments.length === 0 ? null : (
        <ul className="flex flex-wrap gap-3">
          {attachments.map((attachment, index) => {
            const name = `Screenshot ${String(index + 1)}`;
            return (
              <li key={attachment.id} className="space-y-1">
                <a href={screenshotUrl(attachment.id)} target="_blank" rel="noopener noreferrer">
                  <img
                    src={screenshotUrl(attachment.id)}
                    alt={`${name} (opens full size in a new tab)`}
                    height={112}
                    className="h-28 w-auto rounded-sm border border-rule object-contain"
                  />
                </a>
                {confirming === attachment.id ? (
                  <div role="group" aria-label={`Delete ${name}?`} className="flex gap-1">
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => {
                        setProblem(null);
                        setMessage('');
                        remove.mutate(attachment.id);
                      }}
                    >
                      Delete it
                    </Button>
                    <Button
                      ref={keep}
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setConfirming(null);
                        // Back to where the user was.
                        window.setTimeout(() => deleteButtons.current.get(attachment.id)?.focus(), 0);
                      }}
                    >
                      Keep
                    </Button>
                  </div>
                ) : (
                  <Button
                    ref={(element) => {
                      if (element === null) deleteButtons.current.delete(attachment.id);
                      else deleteButtons.current.set(attachment.id, element);
                    }}
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete ${name}`}
                    onClick={() => {
                      setConfirming(attachment.id);
                    }}
                  >
                    Delete
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div
        onDragOver={(event) => {
          event.preventDefault();
        }}
        onDrop={onDrop}
        className="flex max-w-3xl flex-wrap items-center gap-3 rounded-md border border-dashed border-rule px-4 py-3"
      >
        <Button
          type="button"
          variant="outline"
          className={TOUCH}
          aria-describedby={zoneHint}
          disabled={add.isPending}
          onClick={() => {
            picker.current?.click();
          }}
        >
          {add.isPending ? 'Adding…' : 'Add screenshots…'}
        </Button>
        <p id={zoneHint} className="text-sm text-ink-muted">
          Or paste one anywhere on this page, or drop images here. They are converted to WebP in your browser,
          which drops location and camera details, and kept under 1 MB each.
        </p>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label="Screenshot files"
          onChange={(event) => {
            take([...(event.target.files ?? [])]);
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
