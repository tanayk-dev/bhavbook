# ADR-0013: Incomplete history: INCOMPLETE flag plus opening-lot adjustments, including from broker statements

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Zerodha caps tradebooks at 365 days, and IPO allotments don't appear in trade files. Real data has 10 orphan sells (Zerodha) and an IPO lot (Dhan). Sharesight's standard fix is an opening balance. Dhan's Tax Report and Zerodha's Tax P&L list the missing lots with dates and ISINs.

## Decision

Holdings never go negative. A sell beyond what's held marks the position **INCOMPLETE**, and it's excluded from analytics by default. Fixes are `adjustment` records (`opening_lot`, `exclude`, `product_override`) with `source ∈ {manual, broker_statement}`. The issues inbox offers **'Fill from broker statement'** when a matching statement lot exists. The user confirms every adjustment, and every adjustment can be reverted. Imports that later cover a gap offer to replace the adjustment.

## Alternatives Considered

### Alternative 1: Invent a synthetic buy at cost 0
- **Pros**: No warnings
- **Cons**: Fabricates profits
- **Why not**: Dishonest analytics

### Alternative 2: Reject imports with gaps
- **Pros**: Strict
- **Cons**: Unusable with real data
- **Why not**: Real users rarely have full history

## Consequences

### Positive
- Honest analytics; gaps can be fixed with one click

### Negative
- Issues inbox and coverage UI to build

### Risks
- Users ignore warnings → analytics show 'N positions excluded' everywhere

**References**: Brief D11; PRD §5.2, §13; research A3
