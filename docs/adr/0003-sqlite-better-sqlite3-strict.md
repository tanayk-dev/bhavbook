# ADR-0003: SQLite `STRICT` tables through better-sqlite3; DuckDB deferred

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

The data is small (5–40 trades a month per user) and needs transactional imports, exact 64-bit integers and a single-file backup. Node's built-in `node:sqlite` is still experimental on the current LTS line (24) and has no transaction helper.

## Decision

Use **SQLite** via **better-sqlite3**: `STRICT` tables, WAL mode, `safeIntegers` on. Data access goes through hand-written repositories, optionally using **Kysely** as a typed query builder. Migrations are numbered SQL files (ADR-0020). DuckDB is deferred until there is an analytical workload.

## Alternatives Considered

### Alternative 1: node:sqlite
- **Pros**: No native dependency
- **Cons**: Experimental on Node 24; no transaction helper
- **Why not**: Revisit once Node 26 is LTS and the module is stable

### Alternative 2: DuckDB
- **Pros**: Fast analytics
- **Cons**: Not built for OLTP-style imports; extra engine
- **Why not**: v1 has no workload that needs it

### Alternative 3: ORM (Prisma/Drizzle)
- **Pros**: Productivity
- **Cons**: Hides bigint handling; adds a codegen step
- **Why not**: Money correctness needs explicit control of types

## Consequences

### Positive
- Atomic import commits; exact integers; one-file vault
- Mature, synchronous and fast

### Negative
- Native module (prebuilds needed for Windows/macOS/Linux)

### Risks
- A prebuild is missing for a new Node major → pin the supported Node range in `engines`

**References**: Brief D7; PRD §10, §12.1
