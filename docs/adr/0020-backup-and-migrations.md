# ADR-0020: Single-file .bhav backups, BLOB screenshots, forward-only migrations

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

The vault is the user's only copy of their journal. Screenshots stored as loose files would make backups non-atomic.

## Decision

Screenshots are converted to `.webp` **in the browser** (which strips EXIF) and stored as BLOBs (max 1 MB each). `.bhav` is a `VACUUM INTO` snapshot plus a manifest (schema and app versions, SHA-256). Auto-backups run before every migration and every import commit; the last 10 are kept, plus every pre-migration backup. Restore verifies the hash, restores into a temp path, migrates, then swaps. Migrations are numbered, forward-only SQL and are tested by restoring an older fixture.

## Alternatives Considered

### Alternative 1: Files on disk next to the DB
- **Pros**: Smaller DB
- **Cons**: Non-atomic backup
- **Why not**: Integrity risk

### Alternative 2: sharp for image conversion
- **Pros**: Server control
- **Cons**: Another native dependency
- **Why not**: The browser canvas is enough

## Consequences

### Positive
- Atomic, verifiable backups

### Negative
- The DB grows with screenshots

### Risks
- DB bloat → 1 MB cap; revisit if vaults exceed ~1 GB

**References**: domain.md Backup; PRD §10.2
