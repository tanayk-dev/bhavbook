# ADR-0028: Dashboard charts drawn with ECharts on EvilCharts' base

**Date**: 2026-10-22
**Status**: accepted (refines ADR-0022)
**Deciders**: Claude Code during S15b-2, reported to the project author

## Context

ADR-0022 chose EvilCharts' ECharts components for the UI charts, with the calendar heatmap built on EvilCharts'
`echarts-chart` base. Pulling them (`pnpm dlx shadcn@4.22.1 add @evilcharts/echarts-area-chart
@evilcharts/echarts-bar-chart @evilcharts/echarts-chart`) showed:

- The area and bar components are about 2,300 lines each, general-purpose, with dozens of variants (stacked,
  expanded, gradients, brushes, glow). BhavBook's dashboard needs one series per chart.
- As copied they fail this repo's checks: 59 type errors (strict optional property types) and 77 lint errors.
- The `echarts-chart` "base" is not a chart component: it is the renderer registration and colour plumbing.

The dashboard needs three charts: an equity curve, monthly net P&L and a calendar heatmap of daily net.

## Decision

- Keep EvilCharts' base as owned, vendored source (`web/src/components/charts/evilcharts-base.ts`, provenance in
  `SOURCE.md`), trimmed to what is used and adapted to the repo's checks.
- Draw all three charts as small ECharts wrappers in `web/src/components/charts`, the way ADR-0022 already did the
  heatmap: one React wrapper (`echart.tsx`: SVG renderer, sized by its container, rebuilt on a theme change) and the
  three option builders (`pnl-charts.tsx`).
- The chart module loads lazily (ECharts is about 200 kB gzipped), so only the dashboard pays for it.
- Polarity colours for charts are their own tokens (`--chart-gain`, `--chart-loss`, `--chart-neutral`), validated
  with the `dataviz` skill's palette validator for colour vision deficiencies in light and dark mode. The text
  tokens `--gain` / `--loss` (with ▲/▼ glyphs) are unchanged; the stock pair fails the validator as a chart pair
  (deutan ΔE 5.8 light, 4.1 dark). Every chart also has a table of its numbers.

## Alternatives Considered

### Alternative 1: Vendor the EvilCharts area and bar components and fix them
- **Pros**: closest to ADR-0022's wording
- **Cons**: about 4,600 lines of owned code to keep strict-clean for one series per chart; re-pulls would redo
  the fixes
- **Why not**: most of the code would be unused variants

### Alternative 2: Exclude the vendored components from type checks and lint
- **Pros**: no edits to vendored code
- **Cons**: unchecked code in the bundle; the repo's checks protect money and privacy invariants
- **Why not**: the checks are worth more than the convenience

## Consequences

### Positive
- About 400 lines of chart code, all strict-clean; one engine, as ADR-0022 intended
- The dashboard bundle is split: other pages don't load ECharts

### Negative
- EvilCharts' visual variants are not available; new chart kinds are written as option builders

### Risks
- The registry may change its base; re-pull deliberately and diff against `SOURCE.md`
