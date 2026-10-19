# ADR-0025: Analytics units and R-multiple definition

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Win rate, expectancy and R must be computed consistently with scale-ins and partial exits. Tradervue and Van Tharp define R from the initial stop at entry, and moving the stop later shouldn't change R.

## Decision

A **trade** is a CLOSED, non-excluded, complete position. **Realisation views** (calendar, equity curve, monthly) use closed lots by exit date. **R = net P&L ÷ planned risk**, where planned risk is the ₹ amount the user enters, else Σ over entries of \|fill price − initial stop\| × qty. **Breakeven** is \|net\| ≤ threshold (default ₹0) and is excluded from the win-rate denominator.

## Alternatives Considered

### Alternative 1: R from first-entry quantity only
- **Pros**: Simple
- **Cons**: Ignores scale-in risk
- **Why not**: Overstates R

### Alternative 2: Current stop
- **Pros**: Easy
- **Cons**: Rewrites history
- **Why not**: Breaks R's meaning

## Consequences

### Positive
- Honest, comparable metrics

### Negative
- The user must record the initial stop for R

### Risks
- Many trades without stops → shown as 'N trades without a stop'

**References**: PRD §9, §13 Q11
