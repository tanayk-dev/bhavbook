# Chart sources

| File                 | Source                                                                                                                                      | Pulled     | Changes                                                                                                                                                                    |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ | :--------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evilcharts-base.ts` | EvilCharts registry item `@evilcharts/echarts-chart` (MIT), `https://evilcharts.com/r/echarts-chart.json`, via `pnpm dlx shadcn@4.22.1 add` | 2026-10-22 | Trimmed to the SVG renderer registration and the color helpers (`normalizeColor`, `withAlpha`) plus a `token()` reader; adapted to strict optional types and `RegExp#exec` |

The registry has no versioned releases (ADR-0022): re-pull deliberately with the command above and diff against this
file. The registry's generic area and bar chart components were tried and not kept (ADR-0028): BhavBook's three charts
are small ECharts wrappers in this folder.
