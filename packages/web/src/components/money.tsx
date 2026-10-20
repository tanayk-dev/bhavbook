// Money on screen (direction §4.2–4.3): only through formatINR, tabular figures, and never colour alone. A signed
// amount carries a sign, a glyph and words for screen readers; the true minus sign (U+2212) is used.
import { formatINR } from '@bhavbook/core/money';
import { Provenance, type ProvenanceKind } from '@/components/provenance';
import { cn } from '@/lib/utils';

export interface MoneyProps {
  readonly valueMicro: bigint;
  /** P&L: show a sign, a ▲/▼ glyph and gain/loss colour. Off for plain amounts (a cost, a charge). */
  readonly signed?: boolean;
  readonly provenance?: ProvenanceKind;
  readonly className?: string;
}

export function Money({ valueMicro, signed = false, provenance, className }: MoneyProps) {
  const magnitude = formatINR(valueMicro < 0n ? -valueMicro : valueMicro);
  const direction = valueMicro > 0n ? 'gain' : valueMicro < 0n ? 'loss' : 'flat';
  const text = signed
    ? `${direction === 'loss' ? '\u2212' : direction === 'gain' ? '+' : ''}${magnitude}`
    : magnitude;
  const glyph = signed && direction !== 'flat' ? (direction === 'gain' ? '\u25B2' : '\u25BC') : null;
  const spoken =
    signed && direction !== 'flat' ? `${direction === 'gain' ? 'profit' : 'loss'} ${magnitude}` : text;
  return (
    <span
      className={cn(
        'figure inline-flex items-baseline gap-1 whitespace-nowrap',
        signed && direction === 'gain' && 'text-gain',
        signed && direction === 'loss' && 'text-loss',
        className,
      )}
    >
      <span className="sr-only">{spoken}</span>
      <span aria-hidden="true">
        {glyph === null ? null : <span className="mr-1 text-[0.75em]">{glyph}</span>}
        {text}
      </span>
      {provenance === undefined ? null : <Provenance kind={provenance} />}
    </span>
  );
}
