# ADR-0016: Date-versioned fee rules computed per contract note, with golden tests

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Brokers bill STT and stamp duty rounded to the rupee per **contract note** (day), then split them across scrips. Brokerage is per executed order. Rates change mid-year (NSE 0.00322% → 0.00297% on 2024-10-01). Dhan data matched STT on 45/46 days and stamp duty on 46/46.

## Decision

`@bhavbook/core` fees is pure. Rule JSON files are **versioned by effective date** and selected by trade date. Each component is computed at its billing unit (order or contract note = account + IST date + exchange) with the broker's rounding, then **allocated to fills by value using largest remainder**. Every rule version must pass golden tests against the broker statements we hold for its period. MTF interest isn't modelled.

## Alternatives Considered

### Alternative 1: Per-trade computation
- **Pros**: Simple
- **Cons**: Doesn't match rupee rounding
- **Why not**: Fails the golden data

### Alternative 2: Latest rates only
- **Pros**: Simple
- **Cons**: Wrong for history
- **Why not**: Imports span several FYs

## Consequences

### Positive
- Reproducible, auditable estimates

### Negative
- Rule files need maintenance when rates change

### Risks
- Rates drift unnoticed → a documented rule-update path, plus statements reveal drift

**References**: PRD §8.1, §13 Q4/Q13; research A1/A5
