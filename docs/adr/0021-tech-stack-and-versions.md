# ADR-0021: TypeScript monorepo stack, pinned to the latest stable versions (2026-10-19)

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

The author wants the latest stable versions of everything. One conflict: TypeScript 7.0.2 is the latest, but typescript-eslint 8.71.2 (needed for the type-aware money-safety lint rules) supports TypeScript below 6.1.0 only. Node 26 is 'Current' and not yet LTS.

## Decision

pnpm workspaces (`core`, `adapters`, `server`, `web`, `cli`) with **exact pins** (see the table below). **TypeScript 6.0.3**, the latest compatible with typescript-eslint; move to 7.x when typescript-eslint supports it. **Node 24 LTS** (`engines: >=24.11`). Future updates use pnpm `minimumReleaseAge` (3 days) as a supply-chain guard.

### Pinned versions (latest stable on npm, checked 2026-10-19)

| Package | Version | Note |
| :--- | :--- | :--- |
| Node.js | 24.22.0 LTS "Krypton" | Node 26.12.0 is Current, not LTS |
| pnpm | 12.14.0 | |
| typescript | **6.0.3** | 7.0.2 is the latest, but blocked by typescript-eslint's peer range (<6.1.0) |
| better-sqlite3 / @types/better-sqlite3 | 13.0.3 / 9.6.0 | engines node ≥ 22 |
| kysely | 0.29.7 | Optional typed SQL builder |
| hono / @hono/node-server | 4.13.13 / 2.1.5 | |
| react / react-dom | 19.3.1 | |
| vite / @vitejs/plugin-react | 8.3.4 / 6.1.2 | |
| @tanstack/react-router / router-plugin / react-query | 1.170.45 / 1.168.47 / 5.104.4 | |
| tailwindcss / @tailwindcss/vite | 4.3.3 | |
| shadcn (CLI) | 4.22.1 | |
| echarts | 6.1.0 | Used by EvilCharts |
| motion | 14.3.1 | Used by EvilCharts; released 2026-10-19 |
| EvilCharts | registry, `main` @ 2026-10-01 | Copied components, no npm version |
| xlsx (SheetJS CE) | 0.20.3 | From cdn.sheetjs.com tarball |
| csv-parse | 7.0.3 | |
| zod | 4.6.7 | |
| ulid | 3.0.2 | |
| vitest / @vitest/coverage-v8 | 5.0.5 | |
| fast-check | 4.10.2 | |
| @playwright/test | 1.64.1 | |
| eslint / typescript-eslint | 10.13.0 / 8.71.2 | |
| prettier | 3.9.10 | |
| tsx / tsdown | 4.23.15 / 0.23.1 | Dev runner / CLI bundler |
| @types/node | 24.19.2 | Matches Node 24 |
| open | 11.0.4 | Opens the browser from the CLI |

### Added with the web shell (S13a-1, checked 2026-10-20)

These are additions, not changes to the decision above. Each was the latest stable release, unless the 3-day release-age guard (pnpm `minimumReleaseAge`) required the previous one.

| Package | Version | Note |
| :--- | :--- | :--- |
| radix-ui | 1.8.1 | shadcn/ui primitives |
| class-variance-authority / clsx / tailwind-merge | 0.7.1 / 2.1.1 / 3.7.0 | shadcn/ui class helpers |
| tw-animate-css | 1.4.0 | shadcn/ui animations for Tailwind 4 |
| lucide-react | 1.58.0 | Icons (1.59.0 was under 3 days old) |
| @fontsource-variable/inter / @fontsource/jetbrains-mono | 5.3.0 / 5.3.0 | Bundled fonts (no runtime fetch) |
| @types/react / @types/react-dom | 19.3.0 | |
| @testing-library/react / user-event / jest-dom | 16.3.3 / 14.6.8 / 7.0.1 | Component tests |
| jsdom | 30.1.3 | Vitest DOM environment |
| eslint-plugin-react-hooks | 7.1.1 | Rules of hooks |

## Alternatives Considered

### Alternative 1: TypeScript 7.0.2
- **Pros**: Newest, fast native compiler
- **Cons**: typescript-eslint peer range is <6.1.0
- **Why not**: Loses type-aware lint that protects money code

### Alternative 2: Node 26
- **Pros**: Newest; node:sqlite closer to stable
- **Cons**: Not LTS yet
- **Why not**: LTS for a tool users install

## Consequences

### Positive
- Current ecosystem; reproducible installs

### Negative
- Some packages move fast (motion 14.3.1 was released today)

### Risks
- A breaking change in a fresh major → lockfile, CI, and monthly upgrade PRs

**References**: PRD §12.1
