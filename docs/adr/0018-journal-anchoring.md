# ADR-0018: Journal entries anchor to the position's opening entry, not to a position ID

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Positions are derived and can change shape when older history arrives (an INCOMPLETE position merging with a newly imported buy). A journal keyed to a position ID would be orphaned.

## Decision

A journal entry stores an **anchor**: (account, instrument, bucket, the dedup key of the opening entry, or the adjustment ID of an opening lot). After each recompute it attaches to whichever position contains the anchor. A collision raises a 'merge or keep both' issue. A recompute never deletes a journal entry.

## Alternatives Considered

### Alternative 1: Key to position_id
- **Pros**: Simple
- **Cons**: Breaks on recompute
- **Why not**: Data loss risk

## Consequences

### Positive
- Notes survive history changes

### Negative
- Anchor lookup on recompute

### Risks
- Anchor fill removed by undoing an import → the entry is parked as 'unattached', and the user re-links it

**References**: PRD §10.1
