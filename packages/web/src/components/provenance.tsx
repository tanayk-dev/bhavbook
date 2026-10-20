// Provenance marks (direction §3): every figure says where it came from. Typographic glyphs, so they align in
// tables; the meaning is in the accessible name and the tooltip, never in the colour alone.
import { cn } from '@/lib/utils';

export type ProvenanceKind = 'estimated' | 'reconciled' | 'discrepancy' | 'incomplete' | 'inferred';

const MARKS: Readonly<Record<ProvenanceKind, { glyph: string; label: string; tone: string }>> = {
  estimated: { glyph: '\u2248', label: 'Estimated by the fee engine', tone: 'text-ink-muted' },
  reconciled: { glyph: '\u2713', label: "Reconciled with the broker's statement", tone: 'text-reconciled' },
  discrepancy: { glyph: '!', label: "Differs from the broker's statement", tone: 'text-attention' },
  incomplete: { glyph: '\u25D0', label: 'Incomplete history', tone: 'text-ink-muted' },
  inferred: { glyph: '\u24D8', label: 'Product type inferred', tone: 'text-ink-muted' },
};

export interface ProvenanceProps {
  readonly kind: ProvenanceKind;
  /** Extra detail for the tooltip, e.g. the fee-rule versions. */
  readonly detail?: string;
}

export function Provenance({ kind, detail }: ProvenanceProps) {
  const mark = MARKS[kind];
  const title = detail === undefined ? mark.label : `${mark.label}: ${detail}`;
  return (
    <abbr
      title={title}
      aria-label={title}
      className={cn('no-underline text-[0.85em] font-medium', mark.tone)}
    >
      {mark.glyph}
    </abbr>
  );
}
