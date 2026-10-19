# ADR-0019: Store no client identifiers, file names or metadata blocks

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Broker files carry the name, client ID/UCC, mobile and email in metadata blocks and file names. Zerodha IDs are short enough that a hash can be brute-forced back to the ID.

## Decision

The vault stores **no** name, PAN, client ID (hashed or not), mobile, email, original file name or metadata block. Imports keep the `file_sha256`, report kind and coverage only. Wrong-account protection is an **overlap heuristic** (range overlaps but <10% shared keys) plus the preview and undo. Logs and diagnostics never contain raw cell values.

## Alternatives Considered

### Alternative 1: Salted client-ID hash
- **Pros**: Strong wrong-account check
- **Cons**: Brute-forceable, so it's effectively PII
- **Why not**: Fails the privacy bar

## Consequences

### Positive
- Vault and backups are safe to share for bug reports (after review)

### Negative
- The wrong-account check is heuristic

### Risks
- A new broker metadata field leaks → adapter tests assert that metadata isn't stored

**References**: PRD §6.4, §13 Q9; domain.md Privacy
