# ADR-0024: Golden fixtures from scrubbed real exports, plus property tests

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Correctness is the product. We hold real Zerodha and Dhan exports, and Dhan's trade file covers the account's full history, so it can be tested against Dhan's own Tax Report and Global Transactions.

## Decision

Vitest unit tests; **golden tests** for adapters, FIFO (Dhan Tax Report), fees (Dhan Global Transactions; Zerodha once we have a matching-FY Tax P&L) and totals (Zerodha AGTS); `fast-check` property tests for the invariants (idempotency, no negative holdings, FIFO isolation); Playwright E2E. Coverage ≥ 80% overall and 100% branch coverage for money, FIFO and fees. Fixtures are scrubbed copies checked by `ecc:opensource-sanitizer`.

## Alternatives Considered

### Alternative 1: Synthetic fixtures only
- **Pros**: No privacy risk
- **Cons**: Misses real quirks (float32, names, IPO lots)
- **Why not**: The real files found every key rule

## Consequences

### Positive
- Tests prove that we match the broker

### Negative
- Fixture maintenance; scrubbing effort

### Risks
- PII leaks into the repo → the sanitizer runs in CI on `fixtures/`

**References**: PRD §11
