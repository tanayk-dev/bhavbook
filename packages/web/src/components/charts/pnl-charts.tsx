// The dashboard's three charts (PRD §9.1; plan S15b): the equity curve (cumulative realised net), monthly net P&L
// (bars above and below zero, so the sign is in position as well as colour), and the calendar heatmap of daily net
// (a diverging scale with a neutral midpoint, its two arms validated for colour vision deficiencies). Marks follow
// the dataviz rules: thin, a 2 px line, rounded data ends, a recessive grid, a hover tooltip on every chart.
import { formatINR } from '@bhavbook/core/money';
import { BarChart, HeatmapChart, LineChart } from 'echarts/charts';
import {
  CalendarComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components';
import { useCallback, useMemo } from 'react';
import { EChart } from '@/components/charts/echart';
import { echarts, token, withAlpha } from '@/components/charts/evilcharts-base';
import { monthLabel } from '@/components/charts/labels';
import { chartRupees, type Day, type Month } from '@/lib/analytics';
import { formatIstDate } from '@/lib/format';

echarts.use([
  LineChart,
  BarChart,
  HeatmapChart,
  GridComponent,
  TooltipComponent,
  CalendarComponent,
  VisualMapComponent,
  MarkLineComponent,
]);

const MINUS = '−';

/** A signed amount in words-and-glyphs, as Money shows it. */
export const signed = (micro: bigint): string =>
  micro > 0n ? `▲ +${formatINR(micro)}` : micro < 0n ? `▼ ${MINUS}${formatINR(-micro)}` : formatINR(0n);

/** Axis labels in ₹ (lakh grouping), compact. */
const axisRupees = (value: number): string => `₹${Math.round(value).toLocaleString('en-IN')}`;

function base() {
  const ink = token('--ink');
  const muted = token('--ink-muted');
  const rule = token('--rule');
  const surface = token('--surface');
  return {
    ink,
    muted,
    rule,
    surface,
    tooltip: {
      backgroundColor: surface,
      borderColor: rule,
      borderWidth: 1,
      padding: [6, 8],
      textStyle: { color: ink, fontFamily: 'inherit', fontSize: 12 },
      extraCssText: 'box-shadow: none; border-radius: 4px;',
    },
    axisLabel: { color: muted, fontSize: 11, fontFamily: 'inherit' },
    splitLine: { lineStyle: { color: withAlpha(rule, 0.8), width: 1 } },
  };
}

export function EquityChart({ days }: { readonly days: readonly Day[] }) {
  const build = useCallback(() => {
    const look = base();
    const line = token('--accent-ink');
    return {
      animation: false,
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        ...look.tooltip,
        trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: look.muted, width: 1 } },
        formatter: (params: unknown) => {
          const [point] = params as { dataIndex: number }[];
          const day = point === undefined ? undefined : days[point.dataIndex];
          if (day === undefined) return '';
          return `${formatIstDate(day.date)}<br/>Running net ${signed(day.cumulativeMicro)}<br/>That day ${signed(day.netMicro)}`;
        },
      },
      xAxis: {
        type: 'category',
        data: days.map((day) => day.date),
        boundaryGap: false,
        axisLine: { lineStyle: { color: look.rule } },
        axisTick: { show: false },
        axisLabel: { ...look.axisLabel, formatter: (value: string) => formatIstDate(value) },
      },
      yAxis: {
        type: 'value',
        axisLabel: { ...look.axisLabel, formatter: axisRupees },
        splitLine: look.splitLine,
      },
      series: [
        {
          type: 'line',
          data: days.map((day) => chartRupees(day.cumulativeMicro)),
          showSymbol: false,
          lineStyle: { color: line, width: 2 },
          itemStyle: { color: line },
          areaStyle: { color: withAlpha(line, 0.1) },
          markLine: {
            silent: true,
            symbol: 'none',
            label: { show: false },
            lineStyle: { color: look.muted, width: 1, type: 'solid' },
            data: [{ yAxis: 0 }],
          },
        },
      ],
    };
  }, [days]);
  return <EChart label="Equity curve: running realised net P&L by day" build={build} height={240} />;
}

export function MonthlyChart({ months }: { readonly months: readonly Month[] }) {
  const build = useCallback(() => {
    const look = base();
    const gain = token('--chart-gain');
    const loss = token('--chart-loss');
    return {
      animation: false,
      grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
      tooltip: {
        ...look.tooltip,
        trigger: 'item',
        formatter: (params: unknown) => {
          const month = months[(params as { dataIndex: number }).dataIndex];
          if (month === undefined) return '';
          return `${monthLabel(month.month)}<br/>Net ${signed(month.netMicro)}<br/>${String(month.lots)} closed ${
            month.lots === 1 ? 'lot' : 'lots'
          }`;
        },
      },
      xAxis: {
        type: 'category',
        data: months.map((month) => monthLabel(month.month)),
        axisLine: { lineStyle: { color: look.muted } },
        axisTick: { show: false },
        axisLabel: look.axisLabel,
      },
      yAxis: {
        type: 'value',
        axisLabel: { ...look.axisLabel, formatter: axisRupees },
        splitLine: look.splitLine,
      },
      series: [
        {
          type: 'bar',
          barMaxWidth: 28,
          // A 2 px surface gap between neighbouring bars.
          barCategoryGap: '20%',
          data: months.map((month) => ({
            value: chartRupees(month.netMicro),
            itemStyle: {
              color: month.netMicro < 0n ? loss : gain,
              // Rounded at the data end, square at the zero baseline.
              borderRadius: month.netMicro < 0n ? [0, 0, 4, 4] : [4, 4, 0, 0],
              borderColor: look.surface,
              borderWidth: 1,
            },
          })),
        },
      ],
    };
  }, [months]);
  return (
    <EChart
      label="Net P&L by month: bars above zero are gains, below are losses"
      build={build}
      height={240}
    />
  );
}

const DAY_MS = 86_400_000;
const ROW_HEIGHT = 120;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * The calendar rows for a span of days: from the first to the last, at most a year per row (an April-to-March
 * financial year is one row, not two half-empty calendar years).
 */
export function calendarWindows(days: readonly Day[]): [string, string][] {
  const [first] = days;
  const last = days.at(-1);
  if (first === undefined || last === undefined) return [];
  const windows: [string, string][] = [];
  let start = Date.parse(`${first.date}T00:00:00Z`);
  const end = Date.parse(`${last.date}T00:00:00Z`);
  while (start <= end) {
    const next = new Date(start);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    const stop = Math.min(end, next.getTime() - DAY_MS);
    windows.push([isoDay(start), isoDay(stop)]);
    start = stop + DAY_MS;
  }
  return windows;
}

export function CalendarChart({ days }: { readonly days: readonly Day[] }) {
  // Memoised: a new array each render would rebuild the chart each render.
  const windows = useMemo(() => calendarWindows(days), [days]);
  const build = useCallback(() => {
    const look = base();
    // Symmetric around zero, so equal gains and losses are equally strong.
    const extreme = days.reduce((max, day) => Math.max(max, Math.abs(chartRupees(day.netMicro))), 1);
    const byDate = new Map(days.map((day) => [day.date, day]));
    return {
      animation: false,
      tooltip: {
        ...look.tooltip,
        trigger: 'item',
        formatter: (params: unknown) => {
          const [date] = (params as { value: [string, number] }).value;
          const day = byDate.get(date);
          return day === undefined ? '' : `${formatIstDate(day.date)}<br/>Net ${signed(day.netMicro)}`;
        },
      },
      visualMap: {
        show: false,
        type: 'continuous',
        min: -extreme,
        max: extreme,
        inRange: { color: [token('--chart-loss'), token('--chart-neutral'), token('--chart-gain')] },
      },
      calendar: windows.map((range, index) => ({
        range,
        top: 24 + index * ROW_HEIGHT,
        left: 40,
        right: 8,
        cellSize: ['auto', 14],
        splitLine: { show: false },
        itemStyle: { color: token('--surface'), borderColor: look.surface, borderWidth: 2 },
        dayLabel: { ...look.axisLabel, firstDay: 1, nameMap: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] },
        monthLabel: look.axisLabel,
        yearLabel: { ...look.axisLabel, position: 'left' },
      })),
      series: windows.map(([from, to], index) => ({
        type: 'heatmap',
        coordinateSystem: 'calendar',
        calendarIndex: index,
        data: days
          .filter((day) => day.date >= from && day.date <= to)
          .map((day) => [day.date, chartRupees(day.netMicro)]),
      })),
    };
  }, [days, windows]);
  return (
    <div className="space-y-2">
      <EChart
        label="Calendar of realised net P&L by day: deeper green is a bigger gain, deeper red a bigger loss"
        build={build}
        height={32 + windows.length * ROW_HEIGHT}
      />
      <p className="flex items-center gap-2 text-xs text-ink-muted" aria-hidden="true">
        <span>▼ loss</span>
        <span
          className="inline-block h-2 w-24 rounded-sm"
          style={{
            background:
              'linear-gradient(to right, var(--chart-loss), var(--chart-neutral), var(--chart-gain))',
          }}
        />
        <span>gain ▲</span>
      </p>
    </div>
  );
}
