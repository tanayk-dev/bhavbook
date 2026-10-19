# Contributing to BhavBook

Thanks for helping. Before you change anything, read these:

1. **[`docs/product/PRD.md`](docs/product/PRD.md):** what v1 must do, and the invariants that must always hold.
2. **[`docs/adr/`](docs/adr/README.md):** why things are the way they are. To change a decision, add a new ADR that supersedes the old one (copy `docs/adr/template.md`).
3. **[`.claude/rules/bhavbook/domain.md`](.claude/rules/bhavbook/domain.md):** domain rules for money, time, FIFO, fees, ingestion and privacy.

## Ground rules

- **Money is `bigint` micro-rupees.** Never use `parseFloat`, `Number()`, `toFixed` or float arithmetic for money. The `bhavbook/no-float-money` lint rule enforces this in `packages/core` and `packages/adapters`.
- **`core` and `adapters` are pure.** They contain no file, network, database or worker I/O. That belongs in `packages/server`.
- **Test first.** For `core` and `adapters`, open the PR with failing tests (golden files, worked examples, property tests), then make them pass.
- **No personal data, ever.**
  - Real broker exports never enter git: `docs/broker-exports/` is gitignored apart from notes.
  - Fixtures are anonymised copies (no names, PAN, client IDs, mobile numbers or emails).
  - `pnpm pii:scan` and CI enforce this.
- **Exact versions.** Dependencies are pinned exactly (see ADR-0021), and new releases younger than 3 days are held back by pnpm's `minimumReleaseAge`.

## Workflow

- Branch `feat/<step-id>-<slug>` and use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:` …).
- Run `pnpm verify` before pushing. CI runs the same checks on Linux, Windows and macOS.

## Adding a broker

The adapter contract and contributor guide arrive with plan step S5a (`packages/adapters/CONTRACT.md`). Groww and Upstox are planned for v1.1 and are good first contributions.
