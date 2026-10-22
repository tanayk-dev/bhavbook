# ADR-0027: An empty initial stop can be filled in once after the close

**Date**: 2026-10-22
**Status**: accepted
**Deciders**: the user (product owner), with Claude (implementation)

## Context

R is measured against the **initial stop** (ADR-0025, PRD Q11): R = net P&L ÷ planned risk, where planned risk is the
₹ amount the user enters, else Σ over entries of |fill price − initial stop| × qty. Moving the stop later (a trailing
or planned stop) never changes R.

The S14a plan made the initial stop **immutable once the position closes**, including when it was never entered, so
that a stop cannot be widened after the outcome is known to make a loss look smaller in R.

Many traders journal after the fact (a weekly review). Their stop-loss existed when they entered the trade, but they
did not type it into BhavBook until the position had closed. Under the strict rule the field was locked and empty,
and the only way to get an R was to convert the stop into a rupee amount in "Planned risk".

## Decision

- While a position is **open**, the initial stop can be set and changed freely.
- Once it has **closed**:
  - a **recorded** initial stop is fixed: it cannot be moved or cleared;
  - an **empty** initial stop can be filled in, **once**; after that save it is fixed like any recorded stop.
- Merging two colliding journal entries keeps the chosen entry's stop, and fills an empty one from the other entry
  (the other entry's stop was recorded too).
- "Fixed" means while the position is closed: if a later buy reopens the same run, the stop is editable again until
  it closes.
- R's definition does not change.

## Alternatives Considered

### Alternative 1: Fixed once closed, even when empty (the S14a plan)
- **Pros**: no stop can be written after the outcome is known.
- **Cons**: weekly journalers cannot record the stop they actually had; R needs a rupee conversion instead.
- **Why not**: it makes the common after-the-fact journal awkward, while "Planned risk" stays editable anyway, so the
  protection was partial.

### Alternative 2: Always editable
- **Pros**: the most flexible.
- **Cons**: a recorded stop can be widened after a loss, so average R and expectancy can be tidied up after the fact.
- **Why not**: it gives up the honesty R is for.

## Consequences

### Positive
- Traders who journal after the close can record the stop-loss they had at entry, and get an R from it.
- A stop written while the trade was open, or written once after it, can no longer be moved.

### Negative
- A trader who never recorded a stop can choose one after seeing the result. The first stop written is the one kept.

### Risks
- "Planned risk (₹)" remains editable after the close, so R can still be adjusted through it. A later decision may
  treat it the same way; until then the review note can record why it changed.
