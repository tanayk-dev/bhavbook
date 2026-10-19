# ADR-0022: Charts: EvilCharts components on the ECharts engine

**Date**: 2026-10-19
**Status**: accepted
**Deciders**: Project author (Tanay), with Claude Code

## Context

The author chose EvilCharts (MIT, shadcn registry, 3.1k stars, last commit 2026-10-01). It ships Recharts and **ECharts** variants of area, line, bar, composed, pie, radial, radar and sankey charts, but no calendar heatmap. ECharts has a native calendar heatmap.

## Decision

UI charts use **EvilCharts' ECharts components** (`npx shadcn@latest add @evilcharts/echarts-<chart>`). They're copied into `web/src/components/charts` as owned source, on top of shadcn/ui, Tailwind 4, `echarts` and `motion`. The **calendar heatmap** is built on EvilCharts' `echarts-chart` base with ECharts' native `calendar` + `heatmap`, so styling, tooltips and config stay the same. Recharts variants are not installed.

## Alternatives Considered

### Alternative 1: Raw ECharts only
- **Pros**: No dependency on a registry
- **Cons**: Must design every chart
- **Why not**: EvilCharts provides polished defaults

### Alternative 2: EvilCharts Recharts variants
- **Pros**: Popular
- **Cons**: No calendar heatmap in Recharts; two engines
- **Why not**: One engine (ECharts) covers everything

## Consequences

### Positive
- Polished charts quickly; one engine; components are owned code

### Negative
- Copied components don't auto-update → re-pull from the registry deliberately

### Risks
- Registry has no versioned releases → record the commit or date pulled in `components.json` notes

**References**: User decision 2026-10-19; replaces 'Apache ECharts' in PRD §12.1
