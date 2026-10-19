# ADR-0015: Manual corporate actions with tax-faithful lot rules

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

No free, licence-clean corporate-action feed exists. The author's own data includes the Tata Motors demerger (Oct 2025) and a DVR position. Indian tax law gives bonus shares nil cost, with the holding period starting at allotment.

## Decision

Users enter **SPLIT, BONUS, CONVERSION and DEMERGER**. Split: qty × ratio, cost and date unchanged. Bonus: new lots at ₹0 cost dated at allotment. Conversion: lots move to the new ISIN with cost and date carried over. Demerger: child lots get the user-entered cost-split % and the parent's date (e.g. Tata 68.85/31.15). Suspicious patterns raise issues but are never applied automatically.

## Alternatives Considered

### Alternative 1: Auto feed
- **Pros**: No user effort
- **Cons**: No licence-clean source
- **Why not**: Deferred

### Alternative 2: Bonus cost averaged
- **Pros**: Simple journal
- **Cons**: Wrong holding-period class
- **Why not**: The tax-faithful lots give both views

## Consequences

### Positive
- Correct cost basis for real cases

### Negative
- User effort per event

### Risks
- Wrong ratios entered → preview the effect before applying; can be reverted

**References**: Brief D9; PRD §7.4, §13 Q7
