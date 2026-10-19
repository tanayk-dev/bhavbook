# BhavBook

A local-first trade journal for Indian multi-broker equity traders (v1: Zerodha and Dhan). Pre-alpha.

## Commands

pnpm comes from corepack (`packageManager` in `package.json`). Node 24 LTS (see `.nvmrc`).

```bash
corepack enable          # once per machine
pnpm install
pnpm verify              # lint + typecheck + tests with coverage + PII scan + leak check (run before every commit)
pnpm test                # vitest (root config; every package is a project)
pnpm lint                # eslint (type-aware) incl. bhavbook/no-float-money
pnpm typecheck           # tsc --noEmit in every package
pnpm format              # prettier
pnpm fixtures:make       # rebuild packages/adapters/fixtures from the local (gitignored) broker exports
pnpm pii:scan            # scan fixtures for personal data (add ~/.bhavbook-pii-denylist for your own identifiers)
```

## Read first

- Build plan, with the current step and invariants: `plans/bhavbook-v1.md`
- What to build: `docs/product/PRD.md`
- Why it's built that way: `docs/adr/README.md`. Versions are pinned in ADR-0021; change a decision only via a new ADR.
- Domain rules (money, time, FIFO, fees, privacy): `.claude/rules/bhavbook/domain.md`
- Broker file formats: `docs/broker-exports/*/NOTES.md`

## Guardrails

- **Money** is `bigint` micro-rupees. No floats, `parseFloat`, `Number()` or `toFixed` in `packages/core` and `packages/adapters` (enforced by lint).
- **`core` and `adapters` are pure.** All I/O (SQLite, workers, files, HTTP) lives in `packages/server`.
- **Test first** for `core` and `adapters`: failing tests in the first commit.
- **Privacy:** never open or commit files under `docs/broker-exports/` other than `*.md` (they're real exports with personal data). Use the anonymised fixtures in `packages/adapters/fixtures/`. Never store or log names, PAN, client IDs, mobile numbers, emails or original file names.
- Ask the user before outward-facing actions: making the repo public, npm publish, tagging releases.
