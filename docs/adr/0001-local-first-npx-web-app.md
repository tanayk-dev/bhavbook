# ADR-0001: Local-first single-user app served by `npx bhavbook` on 127.0.0.1

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

BhavBook stores PAN-adjacent trading data and strategy notes. The brief rules out a BhavBook-operated backend, telemetry and accounts (anti-goals). The author is a solo, part-time TypeScript developer, and v1 has to ship in about 15 weeks.

## Decision

BhavBook v1 is a Node CLI (`npx bhavbook`). It opens one local vault, serves a web UI bound **only to 127.0.0.1**, and makes **no outbound network calls**. A desktop wrapper (Tauri) is deferred to v2.

## Alternatives Considered

### Alternative 1: Hosted SaaS
- **Pros**: Zero install; easy sharing
- **Cons**: Holds users' trades on our servers; needs ops and money
- **Why not**: Breaks the core privacy promise and the no-backend anti-goal

### Alternative 2: Tauri/Electron desktop app now
- **Pros**: Familiar install for non-technical users
- **Cons**: Packaging, signing and updates per OS; slower iteration
- **Why not**: Too much distribution work for v1; planned for v2

### Alternative 3: Pure browser app (OPFS/IndexedDB)
- **Pros**: No Node needed
- **Cons**: Weak native SQLite story, storage eviction risk, harder backups
- **Why not**: Durability of the user's only copy of their journal matters more

## Consequences

### Positive
- Nothing leaves the machine; no infrastructure cost
- One codebase; fast to iterate

### Negative
- Requires Node, so it excludes non-technical traders in v1
- The user owns backups

### Risks
- Native module install on `npx` (better-sqlite3) could fail → rely on prebuilds; `bhavbook doctor` diagnoses it

**References**: Brief D6; PRD §1, §3.2 invariant 10
