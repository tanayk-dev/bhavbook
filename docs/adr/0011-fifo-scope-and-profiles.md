# ADR-0011: FIFO per (account, ISIN, product bucket); exchange excluded; one profile per account

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Real Zerodha data has buys on NSE closed by sells on BSE. Profiles group accounts, and FIFO must never cross accounts, profiles or product buckets.

## Decision

Lots match **FIFO within (broker_account, instrument, bucket)**, where the instrument is the ISIN (or a broker-local ID until resolved). **Exchange is not part of the key.** Each account belongs to exactly one profile; moving it triggers a recompute.

## Alternatives Considered

### Alternative 1: Key on (symbol, exchange)
- **Pros**: Simple
- **Cons**: Breaks NSE→BSE exits
- **Why not**: Five real symbols prove it wrong

### Alternative 2: FIFO across a profile's accounts
- **Pros**: Single view
- **Cons**: Not how holdings work (separate demat accounts)
- **Why not**: Wrong for cost basis

## Consequences

### Positive
- Matches broker tax reports

### Negative
- Unresolved Dhan names can't merge across accounts until resolved

### Risks
- A symbol rename splits an instrument → ISIN keying avoids it

**References**: PRD §2 C5, §3.2 invariant 6
