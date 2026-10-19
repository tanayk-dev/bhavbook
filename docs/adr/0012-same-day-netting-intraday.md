# ADR-0012: Same-day netting defines intraday for every broker and product

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Zerodha's tradebook has no product column. Dhan declares a product, but it charged and taxed same-day DELIVERY and MTF round trips as intraday. On Dhan's FY 2024-25 Tax Report the netting rule reproduced 11/11 intraday lots, matching the earliest sell first.

## Decision

For each (account, ISIN, IST date): `intraday_qty = min(bought, sold)`, matched **in time order**. That quantity goes to the **INTRADAY** bucket for the journal, FIFO and fees. The remainder keeps its declared or default bucket (DELIVERY/MTF). Fills can be split across buckets. The declared product stays visible, and the user can override per (account, instrument, day).

## Alternatives Considered

### Alternative 1: Trust the declared product (Dhan)
- **Pros**: Literal
- **Cons**: Disagrees with how Dhan charges and taxes
- **Why not**: Contradicted by 11/11 lots

### Alternative 2: Separate journal bucket and fee class
- **Pros**: Shows intent
- **Cons**: Two parallel classifications to keep consistent
- **Why not**: Unnecessary complexity

## Consequences

### Positive
- One rule for all brokers; matches broker tax reports

### Negative
- A single fill may be split into allocations

### Risks
- Edge cases (auctions, T2T scrips) → flagged and overridable

**References**: PRD §7.2–7.3, §13 Q5–Q6; research A2
