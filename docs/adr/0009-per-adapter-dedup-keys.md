# ADR-0009: Per-adapter dedup keys with UNIQUE(account, dedup_key)

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Re-imports and overlapping files must be idempotent. Dhan has no trade or order ID. Zerodha `trade_id`s are 5–9 digits and probably come from sequences that reset, and there's no official statement that they're unique across days.

## Decision

Each adapter defines its own `dedup_key`. **Zerodha:** `zerodha:{exchange}:{trade_date}:{order_id}:{trade_id}`. **Dhan:** `sha256(date,time,name,side,order_type,exchange,qty,value)` plus the occurrence index of identical tuples in the file. The DB enforces `UNIQUE(broker_account_id, dedup_key)`.

## Alternatives Considered

### Alternative 1: (account, trade_id) only
- **Pros**: Matches the old rule
- **Cons**: Unsafe for Zerodha; impossible for Dhan
- **Why not**: Rejected by the evidence

### Alternative 2: Fuzzy match (date + qty + price)
- **Pros**: Broker-agnostic
- **Cons**: False positives on genuinely repeated orders
- **Why not**: Exact keys are available

## Consequences

### Positive
- Idempotent imports across overlapping ranges

### Negative
- Dhan files that cut a day in half could break the occurrence index → Dhan exports are whole-day ranges

### Risks
- The broker changes its ID format → fixtures detect it

**References**: PRD §2 C1, §13 Q3; amends domain.md dedup rule
