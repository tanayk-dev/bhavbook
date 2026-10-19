# ADR-0017: Hybrid costs: engine estimates, broker statements win

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Users trust their broker's statement over any estimate. Dhan Global Transactions gives charges per (date, scrip). Zerodha Tax P&L gives charges per FIFO lot to 4 dp.

## Decision

Net P&L uses **reported charges** wherever an imported statement covers the period (`FEES_RECONCILED`), otherwise the **estimate** (labelled 'estimated'). Tolerances: Dhan ±₹0.01 per component per row, with STT and stamp duty compared per day. Zerodha ±₹0.01 per lot, re-derived from a matching-FY file. A mismatch raises `FEES_DISCREPANCY` but still uses the reported value.

## Alternatives Considered

### Alternative 1: Estimates only
- **Pros**: Simple
- **Cons**: Users see mismatches with their broker
- **Why not**: Trust risk

### Alternative 2: Statements only
- **Pros**: Exact
- **Cons**: Most periods have no statement
- **Why not**: Leaves gaps

## Consequences

### Positive
- Matches what the broker charged; flags engine drift

### Negative
- Two code paths for costs

### Risks
- Allocating statement charges to fills is approximate → done by value with exact sums

**References**: Brief D5; PRD §8.2
