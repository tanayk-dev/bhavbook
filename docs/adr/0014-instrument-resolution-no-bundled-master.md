# ADR-0014: Resolve ISINs by transaction join; no bundled security master

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Dhan trade rows carry only display names, and those names differ between Dhan's own reports ('HCC' vs 'Hindustan Construction Company'). NSE's terms forbid copying or redistributing its website data without written permission.

## Decision

Resolution order: ① the ISIN in the row; ② a **transaction join** with imported Dhan statements ((date, buy qty, sell qty) → statement row → ISIN); ③ learned aliases; ④ manual mapping with suggestions. No NSE/BSE list is bundled. FIFO works on a broker-local identity until an instrument is resolved.

## Alternatives Considered

### Alternative 1: Bundle NSE EQUITY_L / BSE scrip list
- **Pros**: Resolves everything
- **Cons**: Licence risk (NSE terms)
- **Why not**: Conflicts with the no-redistribution anti-goal

### Alternative 2: Exact name matching
- **Pros**: Simple
- **Cons**: 34/36 vs 36/36
- **Why not**: Misses renames and abbreviations

## Consequences

### Positive
- 36/36 resolved on real data; no licence exposure

### Negative
- Requires the user to import at least one statement for Dhan

### Risks
- Later periods have no statements → manual mapping with remembered aliases

**References**: PRD §13 Q10; research A4
