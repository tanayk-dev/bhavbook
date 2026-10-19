# ADR-0004: Money as bigint micro-rupees; rates as bigint rationals; no decimal library

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Floating-point errors make P&L disagree with broker statements. A JS `number` is only safe up to about ₹900 crore in micro-rupees. Fee maths multiplies money by rates such as 0.00297%.

## Decision

Every amount is an integer count of **micro-rupees** (₹1 = 1,000,000), held as `bigint` in TypeScript and `INTEGER` in SQLite. Broker decimal strings are parsed directly to bigint, never through a float. **Rates are bigint rationals** (numerator/denominator) with explicit rounding modes (half-up, half-even, floor). ESLint bans `parseFloat`, `Number()`, `toFixed` and arithmetic on `number` in `core` and `adapters`.

## Alternatives Considered

### Alternative 1: decimal.js / big.js
- **Pros**: Familiar API
- **Cons**: Another runtime type next to bigint; easy to mix up
- **Why not**: Rationals in bigint cover the need exactly

### Alternative 2: Store paise (2 dp)
- **Pros**: Simpler
- **Cons**: Loses precision in fee allocation and 4-dp broker data
- **Why not**: Zerodha Tax P&L allocates to 4 dp

## Consequences

### Positive
- Exact, deterministic maths; overflow isn't a concern in practice

### Negative
- bigint is awkward in JSON → the API serialises money as decimal strings

### Risks
- A developer slips a float into a code path → lint rule plus property tests

**References**: domain.md Money; PRD §3.2 invariant 1
