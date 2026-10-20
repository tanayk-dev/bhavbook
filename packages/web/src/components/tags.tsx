// Setup and mistake tags in settings (PRD §4): add, rename, merge into another tag of the same kind, delete. Merge
// and delete confirm first and say how many journal entries they touch; the entries themselves are never deleted.
// Keyboard-first like the rest of settings: focus moves to the confirm button, and back when it closes.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type SyntheticEvent } from 'react';
import { focusLater, InlineRename, TableRegion, TOUCH } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { saveError } from '@/lib/profiles';
import { createTag, deleteTag, mergeTag, renameTag, tagsQuery, type Tag, type TagKind } from '@/lib/tags';

const KIND_LABEL: Readonly<Record<TagKind, string>> = { setup: 'Setup', mistake: 'Mistake' };

const entries = (count: number): string =>
  `${count.toLocaleString('en-IN')} journal ${count === 1 ? 'entry' : 'entries'}`;

interface AddTagProps {
  readonly kind: TagKind;
  readonly input: { readonly current: HTMLInputElement | null };
  readonly onAdded: (message: string) => void;
}

function AddTag({ kind, input, onAdded }: AddTagProps) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const fieldId = useId();
  const errorId = useId();
  const mutation = useMutation({
    mutationFn: (name: string) => createTag(kind, name),
    onSuccess: async (_, name) => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: tagsQuery.queryKey });
      onAdded(`Added the ${kind} tag ${name.trim()}.`);
    },
    onError: () => input.current?.focus(),
  });
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    mutation.mutate(draft);
  };
  const error = mutation.isError ? saveError(mutation.error, 'tag') : null;
  return (
    <form onSubmit={submit} className="flex max-w-md items-start gap-2">
      <div className="flex-1 space-y-1">
        <Label htmlFor={fieldId} className="sr-only">
          New {kind} tag
        </Label>
        <Input
          ref={input}
          id={fieldId}
          value={draft}
          maxLength={40}
          required
          autoComplete="off"
          placeholder={kind === 'setup' ? 'e.g. Breakout' : 'e.g. Moved stop'}
          aria-invalid={error === null ? undefined : true}
          aria-describedby={error === null ? undefined : errorId}
          onChange={(event) => {
            setDraft(event.target.value);
            mutation.reset();
          }}
        />
        <p id={errorId} role="alert" className="text-sm text-loss">
          {error ?? ''}
        </p>
      </div>
      <Button type="submit" variant="outline" className={TOUCH} disabled={mutation.isPending}>
        {mutation.isPending ? 'Adding…' : `Add ${kind} tag`}
      </Button>
    </form>
  );
}

interface TagActionsProps {
  readonly tag: Tag;
  readonly others: readonly Tag[];
  readonly onDone: (message: string) => void;
  /** After the tag is gone: its row no longer exists, so focus goes elsewhere. */
  readonly onRemoved: () => void;
}

const confirmLabel = (action: 'merge' | 'delete', busy: boolean): string => {
  if (action === 'merge') return busy ? 'Merging…' : 'Merge';
  return busy ? 'Deleting…' : 'Delete tag';
};

type Pending = { readonly action: 'merge'; readonly into: Tag } | { readonly action: 'delete' };

function TagActions({ tag, others, onDone, onRemoved }: TagActionsProps) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<string>();
  const [pending, setPending] = useState<Pending | null>(null);
  const fieldId = useId();
  const questionId = useId();
  const mergeButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const into = others.find((other) => other.id === chosen) ?? others[0];
  const mutation = useMutation({
    mutationFn: (step: Pending) =>
      step.action === 'merge' ? mergeTag(tag.id, step.into.id) : deleteTag(tag.id),
    onSuccess: async (touched, step) => {
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: tagsQuery.queryKey });
      onDone(
        step.action === 'merge'
          ? `Merged ${tag.name} into ${step.into.name}; it was on ${entries(touched)}.`
          : `Deleted ${tag.name} and removed it from ${entries(touched)}.`,
      );
      onRemoved();
    },
  });
  useEffect(() => {
    if (pending !== null) confirmButton.current?.focus();
  }, [pending]);
  if (pending !== null) {
    const cancel = () => {
      setPending(null);
      mutation.reset();
      focusLater(pending.action === 'merge' ? mergeButton : deleteButton);
    };
    const question =
      pending.action === 'merge'
        ? `Merge ${tag.name} into ${pending.into.name}? ${pending.into.name} replaces it on ${entries(tag.uses)}, and ${tag.name} is deleted.`
        : `Delete ${tag.name}? It is removed from ${entries(tag.uses)}; the entries themselves are kept.`;
    return (
      <div
        role="group"
        aria-label={`Confirm ${pending.action === 'merge' ? 'merging' : 'deleting'} ${tag.name}`}
        className="space-y-2 py-1"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !mutation.isPending) cancel();
        }}
      >
        <p id={questionId}>{question}</p>
        {mutation.isError ? (
          <p role="alert" className="text-sm text-loss">
            {saveError(mutation.error, 'tag')}
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            ref={confirmButton}
            aria-describedby={questionId}
            size="sm"
            variant={pending.action === 'delete' ? 'destructive' : 'default'}
            className={TOUCH}
            disabled={mutation.isPending}
            onClick={() => {
              mutation.mutate(pending);
            }}
          >
            {confirmLabel(pending.action, mutation.isPending)}
          </Button>
          <Button variant="ghost" size="sm" className={TOUCH} disabled={mutation.isPending} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      {into === undefined ? null : (
        <>
          <Label htmlFor={fieldId} className="sr-only">
            Merge {tag.name} into
          </Label>
          <select
            id={fieldId}
            value={into.id}
            className="h-11 max-w-40 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:h-8"
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.name}
              </option>
            ))}
          </select>
          <Button
            ref={mergeButton}
            variant="outline"
            size="sm"
            className={TOUCH}
            aria-label={`Merge ${tag.name}…`}
            onClick={() => {
              setPending({ action: 'merge', into });
            }}
          >
            Merge…
          </Button>
        </>
      )}
      <Button
        ref={deleteButton}
        variant="ghost"
        size="sm"
        className={TOUCH}
        aria-label={`Delete ${tag.name}…`}
        onClick={() => {
          setPending({ action: 'delete' });
        }}
      >
        Delete…
      </Button>
    </span>
  );
}

export interface TagTableProps {
  readonly kind: TagKind;
  readonly tags: readonly Tag[];
  readonly announce: (message: string) => void;
}

/** One kind's tags: an add form, then a table with rename, merge and delete per tag. */
export function TagTable({ kind, tags, announce }: TagTableProps) {
  const input = useRef<HTMLInputElement>(null);
  const ofKind = tags.filter((tag) => tag.kind === kind);
  const label = `${KIND_LABEL[kind]} tags`;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">{label}</h3>
      <AddTag kind={kind} input={input} onAdded={announce} />
      {ofKind.length === 0 ? (
        <p className="text-ink-muted">No {kind} tags yet.</p>
      ) : (
        <TableRegion label={label}>
          <table className="w-full min-w-xl border-y border-rule bg-surface text-left">
            <caption className="sr-only">{label}</caption>
            <thead className="text-ink-muted">
              <tr className="h-8 border-b border-rule">
                <th scope="col" className="px-3 font-medium">
                  Tag
                </th>
                <th scope="col" className="w-36 px-3 text-right font-medium">
                  Journal entries
                </th>
                <th scope="col" className="px-3 font-medium">
                  Merge or delete
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-rule">
              {ofKind.map((tag) => (
                <tr key={tag.id} className="align-top">
                  <th scope="row" className="px-3 font-normal">
                    <InlineRename
                      what={`${kind} tag name`}
                      kind="tag"
                      value={tag.name}
                      queryKey={tagsQuery.queryKey}
                      save={(name) => renameTag(tag.id, name)}
                      onSaved={(name) => {
                        announce(`Renamed the tag to ${name}.`);
                      }}
                    />
                  </th>
                  <td className="figure px-3 pt-1.5 text-right">{tag.uses.toLocaleString('en-IN')}</td>
                  <td className="px-3 py-1">
                    <TagActions
                      tag={tag}
                      others={ofKind.filter((other) => other.id !== tag.id)}
                      onDone={announce}
                      onRemoved={() => {
                        focusLater(input);
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableRegion>
      )}
    </div>
  );
}
