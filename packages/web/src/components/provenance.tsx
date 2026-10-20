// Provenance marks (direction §3): every figure says where it came from. Typographic glyphs, so they align in
// tables. Each mark is a focusable image with an accessible name, so keyboard and screen-reader users reach the
// explanation too; the tooltip is the native title (the meaning is never in the colour alone).
import { cn } from '@/lib/utils';

export type ProvenanceKind = 'estimated' | 'reconciled' | 'discrepancy' | 'incomplete' | 'inferred';

const MARKS: Readonly<Record<ProvenanceKind, { glyph: string; label: string; tone: string }>> = {
  estimated: { glyph: '≈', label: 'Estimated by the fee engine', tone: 'text-ink-muted' },
  reconciled: { glyph: '✓', label: "Reconciled with the broker's statement", tone: 'text-reconciled' },
  discrepancy: { glyph: '!', label: "Differs from the broker's statement", tone: 'text-attention' },
  incomplete: { glyph: '◐', label: 'Incomplete history', tone: 'text-ink-muted' },
  inferred: { glyph: 'ⓘ', label: 'Product type inferred', tone: 'text-ink-muted' },
};

export interface ProvenanceProps {
  readonly kind: ProvenanceKind;
  /** Extra detail for the tooltip, e.g. the fee-rule versions. */
  readonly detail?: string;
}

export function Provenance({ kind, detail }: ProvenanceProps) {
  const mark = MARKS[kind];
  const label = detail === undefined ? mark.label : `${mark.label}: ${detail}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      // Focusable so the explanation is reachable by keyboard, not only by mouse hover.
      tabIndex={0}
      className={cn('cursor-help rounded-sm text-[0.85em] font-medium', mark.tone)}
    >
      {mark.glyph}
    </span>
  );
}
