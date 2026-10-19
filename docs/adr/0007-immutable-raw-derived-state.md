# ADR-0007: Imported rows are immutable; everything else is derived by a pure recompute

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Users import overlapping files, add older history later, override inferred products, and enter corporate actions and opening lots. Editing imported rows in place would destroy the audit trail and make re-imports conflict with fixes.

## Decision

Imported rows are stored **exactly as received** (raw text, file hash, line number) and are never edited. Orders, positions, lots, charges and analytics are **a pure, deterministic function** of three inputs: (imported rows + adjustments + corporate actions + fee rules). Recomputing from scratch gives identical results. Fixes are separate, revertible adjustment records. A whole import can be undone.

## Alternatives Considered

### Alternative 1: Mutable trade table edited in the UI
- **Pros**: Simple CRUD
- **Cons**: No audit trail; re-import overwrites or duplicates fixes
- **Why not**: Conflicts with idempotent import and the D11 fixes

## Consequences

### Positive
- Auditability; safe re-imports; easy to test (golden in, golden out)

### Negative
- Recompute cost → incremental recompute per (account, instrument) when needed

### Risks
- Recompute becomes slow on large vaults → target: 20k rows in under 3 s (PRD §12)

**References**: PRD §3.2 invariants 2–3
