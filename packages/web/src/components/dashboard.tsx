// The dashboard (PRD §9; direction §5.5; plan S15b): the filter bar, the metrics strip (plain figures with their
// provenance marks, and what was left out), the equity curve, monthly P&L and the calendar heatmap (each with a
// table of the same numbers), and the setup and mistake tables. Amounts go through Money; ratios stay exact until
// formatted; dates are IST.
import { Component, lazy, Suspense, useId, type ReactNode } from 'react';
import { monthLabel } from '@/components/charts/labels';
import { Money } from '@/components/money';
import { TableRegion } from '@/components/settings';
import { Label } from '@/components/ui/label';
import {
  dashboardFilterOf,
  decimal,
  microOf,
  percent,
  type Analytics,
  type DashboardFilter,
  type Metrics,
  type Slice,
} from '@/lib/analytics';
import { formatIstDate } from '@/lib/format';
import type { Profile } from '@/lib/profiles';

// ECharts is large: the charts load only when the dashboard shows one.
const EquityChart = lazy(async () => ({
  default: (await import('@/components/charts/pnl-charts')).EquityChart,
}));
const MonthlyChart = lazy(async () => ({
  default: (await import('@/components/charts/pnl-charts')).MonthlyChart,
}));
const CalendarChart = lazy(async () => ({
  default: (await import('@/components/charts/pnl-charts')).CalendarChart,
}));

/** A chart that fails (its chunk does not load, ECharts throws) leaves the page and its table standing. */
class ChartBoundary extends Component<{ readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) {
      return (
        <p className="text-sm text-ink-muted">
          The chart could not be drawn; its table below has the numbers.
        </p>
      );
    }
    return this.props.children;
  }
}

const SELECT =
  'h-11 rounded-md border border-input bg-surface px-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden md:h-9';

export interface FilterBarProps {
  readonly filter: DashboardFilter;
  readonly profiles: readonly Profile[];
  readonly onChange: (filter: DashboardFilter) => void;
}

/** One row of filters above the charts; every change is a URL change. */
export function FilterBar({ filter, profiles, onChange }: FilterBarProps) {
  const ids = {
    profile: useId(),
    account: useId(),
    broker: useId(),
    bucket: useId(),
    from: useId(),
    to: useId(),
    incomplete: useId(),
  };
  const set = (key: keyof DashboardFilter, value: string | boolean) => {
    onChange(dashboardFilterOf({ ...filter, [key]: value }));
  };
  const brokerOf = (accountId: string | undefined) =>
    profiles.flatMap((profile) => profile.accounts).find((account) => account.id === accountId)?.broker;
  const accounts = profiles
    .filter((profile) => filter.profileId === undefined || profile.id === filter.profileId)
    .flatMap((profile) => profile.accounts);
  return (
    <form
      role="search"
      aria-label="Filter the dashboard"
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        // Every change applies at once; there is nothing to submit.
        event.preventDefault();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={ids.profile}>Profile</Label>
        <select
          id={ids.profile}
          className={SELECT}
          value={filter.profileId ?? ''}
          onChange={(event) => {
            onChange(dashboardFilterOf({ ...filter, profileId: event.target.value, accountId: '' }));
          }}
        >
          <option value="">All profiles</option>
          {profiles.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.account}>Account</Label>
        <select
          id={ids.account}
          className={SELECT}
          value={filter.accountId ?? ''}
          onChange={(event) => {
            set('accountId', event.target.value);
          }}
        >
          <option value="">All accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.nickname}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.broker}>Broker</Label>
        <select
          id={ids.broker}
          className={SELECT}
          value={filter.broker ?? ''}
          onChange={(event) => {
            const broker = event.target.value;
            // An account of another broker would leave nothing to show.
            const keepAccount = broker === '' || brokerOf(filter.accountId) === broker;
            onChange(dashboardFilterOf({ ...filter, broker, ...(keepAccount ? {} : { accountId: '' }) }));
          }}
        >
          <option value="">All brokers</option>
          <option value="zerodha">Zerodha</option>
          <option value="dhan">Dhan</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.bucket}>Product</Label>
        <select
          id={ids.bucket}
          className={SELECT}
          value={filter.bucket ?? ''}
          onChange={(event) => {
            set('bucket', event.target.value);
          }}
        >
          <option value="">All products</option>
          <option value="DELIVERY">Delivery</option>
          <option value="INTRADAY">Intraday</option>
          <option value="MTF">MTF</option>
        </select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.from}>From</Label>
        <input
          id={ids.from}
          type="date"
          className={SELECT}
          value={filter.from ?? ''}
          {...(filter.to === undefined ? {} : { max: filter.to })}
          onChange={(event) => {
            set('from', event.target.value);
          }}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={ids.to}>To</Label>
        <input
          id={ids.to}
          type="date"
          className={SELECT}
          value={filter.to ?? ''}
          {...(filter.from === undefined ? {} : { min: filter.from })}
          onChange={(event) => {
            set('to', event.target.value);
          }}
        />
      </div>
      <label htmlFor={ids.incomplete} className="flex h-11 items-center gap-2 text-sm md:h-9">
        <input
          id={ids.incomplete}
          type="checkbox"
          checked={filter.includeIncomplete === true}
          onChange={(event) => {
            set('includeIncomplete', event.target.checked);
          }}
        />
        Include incomplete positions
      </label>
    </form>
  );
}

/** Where the net comes from: incomplete history first, then estimated charges; nothing to vouch for without trades. */
function provenance(metrics: Metrics, includedIncomplete: number) {
  if (metrics.trades === 0) return {};
  if (includedIncomplete > 0) return { provenance: 'incomplete' as const };
  return { provenance: metrics.estimated ? ('estimated' as const) : ('reconciled' as const) };
}

function Figure({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="figure text-base">{children}</dd>
    </div>
  );
}

/** The metrics strip: plain figures, not cards (direction §5.5). */
export function MetricsStrip({
  metrics,
  includedIncomplete,
}: {
  readonly metrics: Metrics;
  readonly includedIncomplete: number;
}) {
  const { excluded } = metrics;
  const leftOut = [
    excluded.incomplete === 0
      ? null
      : `${String(excluded.incomplete)} incomplete ${excluded.incomplete === 1 ? 'position' : 'positions'}`,
    excluded.excluded === 0
      ? null
      : `${String(excluded.excluded)} excluded ${excluded.excluded === 1 ? 'position' : 'positions'}`,
  ].filter((part): part is string => part !== null);
  return (
    <section aria-labelledby="metrics" className="space-y-2">
      <h2 id="metrics" className="sr-only">
        Metrics
      </h2>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-3 border-y border-rule py-3 sm:grid-cols-4 lg:grid-cols-7">
        <Figure label="Net P&L">
          <Money valueMicro={metrics.netMicro} signed {...provenance(metrics, includedIncomplete)} />
        </Figure>
        <Figure label="Win rate">{metrics.winRate === null ? '—' : percent(metrics.winRate)}</Figure>
        <Figure label="Expectancy">
          {metrics.expectancy === null ? '—' : <Money valueMicro={microOf(metrics.expectancy)} signed />}
        </Figure>
        <Figure label="Profit factor">
          {metrics.profitFactor === null
            ? '—'
            : metrics.profitFactor === 'no_losses'
              ? 'No losses'
              : decimal(metrics.profitFactor)}
        </Figure>
        <Figure label="Average R">{metrics.avgR === null ? '—' : `${decimal(metrics.avgR)}R`}</Figure>
        <Figure label="Trades">{metrics.trades.toLocaleString('en-IN')}</Figure>
        <Figure label="Without a stop">{excluded.noStop.toLocaleString('en-IN')}</Figure>
      </dl>
      <p className="text-sm text-ink-muted">
        {metrics.wins.toLocaleString('en-IN')} won, {metrics.losses.toLocaleString('en-IN')} lost
        {metrics.breakevens === 0 ? '' : `, ${metrics.breakevens.toLocaleString('en-IN')} breakeven`}.{' '}
        {leftOut.length === 0 ? '' : `Left out: ${leftOut.join(' and ')}. `}
        {includedIncomplete === 0
          ? ''
          : `Included: ${String(includedIncomplete)} incomplete ${
              includedIncomplete === 1 ? 'position' : 'positions'
            } (◐), whose history is missing trades. `}
        {metrics.estimated ? 'Some charges are estimates (≈) until a broker statement covers them.' : ''}
      </p>
    </section>
  );
}

function ChartSection({
  id,
  title,
  chart,
  table,
}: {
  readonly id: string;
  readonly title: string;
  readonly chart: ReactNode;
  readonly table: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="font-semibold">
        {title}
      </h2>
      <ChartBoundary>
        <Suspense fallback={<div className="h-60 rounded-sm bg-muted" aria-hidden="true" />}>
          {chart}
        </Suspense>
      </ChartBoundary>
      <details>
        <summary className="cursor-pointer text-sm text-ink-muted">Show as a table</summary>
        <div className="mt-2">{table}</div>
      </details>
    </section>
  );
}

function DayTable({ analytics, label }: { readonly analytics: Analytics; readonly label: string }) {
  return (
    <TableRegion label={label}>
      <table className="w-full min-w-md border-y border-rule bg-surface text-left text-sm">
        <caption className="sr-only">{label}</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              Day
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Net
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Running total
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {analytics.days.map((day) => (
            <tr key={day.date} className="h-8">
              <th scope="row" className="figure px-3 text-left font-normal">
                {formatIstDate(day.date)}
              </th>
              <td className="px-3 text-right">
                <Money valueMicro={day.netMicro} signed />
              </td>
              <td className="px-3 text-right">
                <Money valueMicro={day.cumulativeMicro} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

function MonthTable({ analytics }: { readonly analytics: Analytics }) {
  return (
    <TableRegion label="Realised P&L by month">
      <table className="w-full min-w-md border-y border-rule bg-surface text-left text-sm">
        <caption className="sr-only">Realised P&L by month</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              Month
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Gross
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Charges
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Net
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {analytics.months.map((month) => (
            <tr key={month.month} className="h-8">
              <th scope="row" className="px-3 text-left font-normal">
                {monthLabel(month.month)}
              </th>
              <td className="px-3 text-right">
                <Money valueMicro={month.grossMicro} signed />
              </td>
              <td className="px-3 text-right">
                <Money valueMicro={month.chargesMicro} />
              </td>
              <td className="px-3 text-right">
                <Money valueMicro={month.netMicro} signed />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

function SliceTable({
  caption,
  heading,
  slices,
  none,
}: {
  readonly caption: string;
  readonly heading: string;
  readonly slices: readonly Slice[];
  readonly none: string;
}) {
  if (slices.length === 0) return <p className="text-sm text-ink-muted">{none}</p>;
  return (
    <TableRegion label={caption}>
      <table className="w-full min-w-xl border-y border-rule bg-surface text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-ink-muted">
          <tr className="h-8 border-b border-rule">
            <th scope="col" className="px-3 font-medium">
              {heading}
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Trades
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Win rate
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Net
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Expectancy
            </th>
            <th scope="col" className="px-3 text-right font-medium">
              Average R
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {slices.map(({ tag, metrics }) => (
            <tr key={tag ?? ''} className="h-8">
              <th scope="row" className="px-3 text-left font-normal">
                {tag ?? <span className="text-ink-muted">None</span>}
              </th>
              <td className="figure px-3 text-right">{metrics.trades.toLocaleString('en-IN')}</td>
              <td className="figure px-3 text-right">
                {metrics.winRate === null ? '—' : percent(metrics.winRate)}
              </td>
              <td className="px-3 text-right">
                <Money valueMicro={metrics.netMicro} signed />
              </td>
              <td className="px-3 text-right">
                {metrics.expectancy === null ? (
                  '—'
                ) : (
                  <Money valueMicro={microOf(metrics.expectancy)} signed />
                )}
              </td>
              <td className="figure px-3 text-right">
                {metrics.avgR === null ? '—' : `${decimal(metrics.avgR)}R`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableRegion>
  );
}

/** Everything below the filter bar. */
export function Dashboard({ analytics }: { readonly analytics: Analytics }) {
  return (
    <div className="space-y-8">
      <MetricsStrip metrics={analytics.summary} includedIncomplete={analytics.includedIncomplete} />
      {analytics.days.length === 0 ? (
        <p className="text-sm text-ink-muted">No realised P&L in this range.</p>
      ) : (
        <>
          <p className="text-sm text-ink-muted">
            The charts count realised P&amp;L on the day it happened, partial exits of positions still open
            included; the figures above count closed trades.
            {analytics.summary.estimated ? ' Some charges in them are estimates.' : ''}
          </p>
          <ChartSection
            id="equity"
            title="Equity curve"
            chart={<EquityChart days={analytics.days} />}
            table={<DayTable analytics={analytics} label="Running realised net by day" />}
          />
          <ChartSection
            id="monthly"
            title="Net P&L by month"
            chart={<MonthlyChart months={analytics.months} />}
            table={<MonthTable analytics={analytics} />}
          />
          <ChartSection
            id="calendar"
            title="Daily net P&L"
            chart={<CalendarChart days={analytics.days} />}
            table={<DayTable analytics={analytics} label="Realised net by calendar day" />}
          />
        </>
      )}
      <section aria-labelledby="by-setup" className="space-y-2">
        <h2 id="by-setup" className="font-semibold">
          By setup
        </h2>
        <SliceTable
          caption="Trades by setup"
          heading="Setup"
          slices={analytics.bySetup}
          none="No closed trades in this view."
        />
      </section>
      <section aria-labelledby="by-mistake" className="space-y-2">
        <h2 id="by-mistake" className="font-semibold">
          By mistake
        </h2>
        <SliceTable
          caption="Trades by mistake"
          heading="Mistake"
          slices={analytics.byMistake}
          none="No trades tagged with a mistake in this view. Tag them in the journal."
        />
      </section>
    </div>
  );
}
