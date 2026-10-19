# ADR-0008: Pure broker adapters producing canonical fill-or-order rows

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Zerodha rows are exchange fills with IDs. Dhan rows are orders or aggregates with no IDs, no ISIN and a rounded price. Groww and Upstox arrive in v1.1, and community contributors should be able to add brokers.

## Decision

Each broker is a **pure adapter** (`detect` and `parse`: bytes in, data out; no I/O or DB). It emits canonical rows with `granularity ∈ {fill, order}`, `price_micro`, `trade_value_micro`, `value_authority ∈ {price, value}`, a nullable ISIN, a declared product and the raw row. Dhan's `Trade Value` is authoritative. Each adapter ships scrubbed real-format fixtures and golden output.

## Alternatives Considered

### Alternative 1: Fill-only canonical model
- **Pros**: Simpler
- **Cons**: Dhan can't provide fills
- **Why not**: Doesn't fit the real data (C4)

### Alternative 2: price_micro as the single source of truth
- **Pros**: Simpler
- **Cons**: Dhan qty × price ≠ value in 16 of 116 rows
- **Why not**: Would make P&L wrong (C3)

## Consequences

### Positive
- One contract for every broker; easy contributor path

### Negative
- The canonical row is wider

### Risks
- A new broker breaks assumptions → the contract is versioned; ADR to extend it

**References**: PRD §2 C3–C4, §6; amends domain.md 'Partial fills'
