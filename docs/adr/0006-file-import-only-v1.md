# ADR-0006: v1 ingests broker files only: no APIs, no stored credentials

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

Swing traders don't need same-day sync. Broker API tokens are secrets that would need encryption-at-rest, rotation and OAuth listeners.

## Decision

v1 imports **CSV, XLSX and XLS files the user downloads**. There is no broker API, no OAuth and no stored secret. The adapter contract (ADR-0008) leaves room for read-only API sources in v2.x.

## Alternatives Considered

### Alternative 1: Read-only broker APIs in v1
- **Pros**: Fresher data
- **Cons**: Secrets storage, daily token renewal, per-broker API terms
- **Why not**: Large security surface for little v1 value

## Consequences

### Positive
- A whole class of security risk disappears
- Works offline

### Negative
- The user downloads files manually

### Risks
- Broker formats change → fixture tests per format and a clear parse-error UI

**References**: Brief D4
