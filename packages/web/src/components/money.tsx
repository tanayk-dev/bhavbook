// Money on screen (direction §4.2–4.3): only through formatINR, tabular figures, and never colour alone. A negative
// amount always shows the true minus sign (U+2212); a signed P&L also gets a plus sign, a ▲/▼ glyph and its colour.
// Screen readers hear words ("profit", "loss", "minus") instead of glyphs.
import { formatINR } from '@bhavbook/core/money';
import { Provenance, type ProvenanceKind } from '@/components/provenance';
import { cn } from '@/lib/utils';

export interface MoneyProps {
  readonly valueMicro: bigint;
  /** P&L: a plus sign for gains, a ▲/▼ glyph and gain/loss colour. Off for plain amounts (a cost, a balance). */
  readonly signed?: boolean;
  readonly provenance?: ProvenanceKind;
  readonly className?: string;
}

const MINUS = '−';

function describe(valueMicro: bigint, signed: boolean) {
  const magnitude = formatINR(valueMicro < 0n ? -valueMicro : valueMicro);
  const direction = valueMicro > 0n ? 'gain' : valueMicro < 0n ? 'loss' : 'flat';
  if (!signed || direction === 'flat') {
    const negative = direction === 'loss';
    return {
      direction: 'flat' as const,
      text: negative ? `${MINUS}${magnitude}` : magnitude,
      glyph: null,
      spoken: negative ? `minus ${magnitude}` : magnitude,
    };
  }
  return {
    direction,
    text: `${direction === 'gain' ? '+' : MINUS}${magnitude}`,
    glyph: direction === 'gain' ? '▲' : '▼',
    spoken: `${direction === 'gain' ? 'profit' : 'loss'} ${magnitude}`,
  };
}

export function Money({ valueMicro, signed = false, provenance, className }: MoneyProps) {
  const { direction, text, glyph, spoken } = describe(valueMicro, signed);
  return (
    <span
      className={cn(
        'figure relative inline-flex items-baseline gap-1 whitespace-nowrap',
        direction === 'gain' && 'text-gain',
        direction === 'loss' && 'text-loss',
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
