# ADR-0005: Store UTC; compute all market logic in Asia/Kolkata

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Brokers export timestamps without a timezone, and those timestamps are IST. Trade dates, same-day netting, holding periods and month buckets all depend on the IST calendar. Users may run the app with a different machine timezone.

## Decision

Store `executed_at` as UTC ISO-8601 and `trade_date_ist` as a date. Broker timestamps are **interpreted as IST** during ingestion. All date logic uses an explicit `Asia/Kolkata` zone and never the machine's local zone.

## Alternatives Considered

### Alternative 1: Store local time as-is
- **Pros**: Matches files
- **Cons**: Ambiguous; breaks on other machines
- **Why not**: Not portable or testable

## Consequences

### Positive
- Deterministic results on any machine

### Negative
- Every date helper needs an explicit zone argument

### Risks
- Silent use of the local zone → tests run under `TZ=America/New_York` in CI

**References**: domain.md Time; PRD §3.2 invariant 7
