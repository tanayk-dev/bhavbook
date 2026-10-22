// The position detail (PRD §4, §5.2; plan S14a): what the position is (flags in words), its figures, the lots, every
// fill as the broker wrote it and as BhavBook read it (declared vs assigned product), and the charges estimated vs
// billed. A closed position can be marked reviewed or reopened here. The journal form follows in S14a-3b.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Money } from '@/components/money';
import { TableRegion, TOUCH } from '@/components/settings';
import { Disconnected, EmptyState, ErrorState, LoadingRows } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { formatIstDate, formatIstDateTime, istDateOf } from '@/lib/format';
import {
  chargeLines,
  netProvenance,
  positionQuery,
  reviewError,
  setReviewed,
  type PositionDetail,
  type PositionFill,
} from '@/lib/positions';

export const Route = createFileRoute('/positions/$ref')({ component: PositionPage });

const COMPONENTS: Readonly<Record<string, string>> = {
  brokerage: 'Brokerage',
  stt: 'STT',
  exchange_txn: 'Exchange charges',
  sebi: 'SEBI fee',
  ipft: 'IPFT',
  stamp_duty: 'Stamp duty',
  gst: 'GST',
  dp: 'DP charges',
};

const FEE_STATUS: Readonly<Record<string, string>> = {
  FEES_ESTIMATED: 'Some or all charges are estimated: no broker statement covers them yet.',
  FEES_RECONCILED: 'Charges match the broker statement.',
  FEES_DISCREPANCY: 'The broker billed differently from the estimate; the billed amounts count.',
};

const SOURCES: Readonly<Record<PositionFill['source'], string>> = {
  trade: 'Trade',
  opening_lot: 'Opening lot (added by you)',
  corporate_action: 'Corporate action',
};

const qty = (value: bigint): string => value.toLocaleString('en-IN');

function PositionPage() {
  const { ref } = Route.useParams();
  const detail = useQuery(positionQuery(ref));
  const disconnection = detail.error instanceof ApiError ? detail.error.disconnection : null;
  if (disconnection !== null) return <Disconnected reason={disconnection} />;
  if (detail.isPending) return <LoadingRows label="Loading the position" rows={6} />;
  if (detail.isError) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return (
        <EmptyState title="This position is no longer there">
          New trades or an undone import rebuilt it.{' '}
          <Link to="/review" className="text-primary underline-offset-4 hover:underline">
            Back to the review queue
          </Link>
          .
        </EmptyState>
      );
    }
    return (
      <ErrorState
        message="Could not read the position."
        retrying={detail.isFetching}
        onRetry={() => {
          void detail.refetch();
        }}
      />
    );
  }
  return <Position detail={detail.data} />;
}

function Flags({ detail }: { readonly detail: PositionDetail }) {
  const { position, fills } = detail;
  const notes = [
    position.incomplete
      ? `Incomplete: ${qty(position.orphanQty)} shares were sold that BhavBook never saw bought. See Issues.`
      : null,
    position.excluded ? 'Excluded from every metric (your choice).' : null,
    fills.some((fill) => fill.inferred)
      ? 'The product type was inferred: the broker file does not say whether this was intraday or delivery.'
      : null,
    position.bucket === 'MTF' ? 'Margin (MTF) interest is not included in the charges.' : null,
    position.feeStatus === null ? null : (FEE_STATUS[position.feeStatus] ?? null),
  ].filter((note): note is string => note !== null);
  if (notes.length === 0) return null;
  return (
    <ul className="space-y-1 text-sm">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}

function Review({ detail }: { readonly detail: PositionDetail }) {
  const { position } = detail;
  const queryClient = useQueryClient();
  const [message, setMessage] = useState('');
  const reviewed = position.reviewedAt !== null;
  const toggle = useMutation({
    mutationFn: () => setReviewed(position.ref, !reviewed),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
      setMessage(reviewed ? 'Back in the review queue.' : 'Marked reviewed.');
    },
    onError: async (error) => {
      setMessage(reviewError(error));
      // A position rebuilt away (not_found) then shows as gone rather than staying on a dead page.
      await queryClient.invalidateQueries({ queryKey: ['positions'] });
    },
  });
  if (position.state !== 'CLOSED' && !reviewed) return null;
  // Like the queue: an incomplete or excluded position is settled in Issues before it is reviewed.
  if (!reviewed && (position.incomplete || position.excluded)) {
    return (
      <p className="text-sm">
        Not reviewed yet. Settle it in{' '}
        <Link to="/issues" className="text-primary underline-offset-4 hover:underline">
          Issues
        </Link>{' '}
        first: its P&amp;L is not complete.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-sm">
        {reviewed ? `Reviewed on ${formatIstDate(istDateOf(position.reviewedAt))}.` : 'Not reviewed yet.'}
      </p>
      <Button
        variant={reviewed ? 'outline' : 'default'}
        className={TOUCH}
        disabled={toggle.isPending}
        onClick={() => {
          toggle.mutate();
        }}
      >
        {reviewed ? 'Reopen review' : 'Mark reviewed'}
      </Button>
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}

function Figures({ detail }: { readonly detail: PositionDetail }) {
  const { position } = detail;
  const closed = position.state === 'CLOSED';
  const rows: [string, React.ReactNode][] = [
    [
      'Bought',
      <>
        {qty(position.boughtQty)} shares for <Money valueMicro={position.boughtValueMicro} />
      </>,
    ],
    ['Sold', <Money key="sold" valueMicro={position.soldValueMicro} />],
    ...(closed ? [] : ([['Still held', `${qty(position.openQty)} shares`]] as [string, React.ReactNode][])),
    [
      'Realised P&L before charges',
      <Money
        key="gross"
        valueMicro={position.realisedGrossMicro}
        signed
        {...(position.incomplete ? { provenance: 'incomplete' as const } : {})}
      />,
    ],
    [
      'Charges',
      <Money key="charges" valueMicro={position.chargesMicro} provenance={netProvenance(position)} />,
    ],
    ...(closed
      ? ([
          [
            'Net P&L',
            <Money
              key="net"
              valueMicro={position.realisedGrossMicro - position.chargesMicro}
              signed
              provenance={netProvenance(position)}
            />,
          ],
        ] as [string, React.ReactNode][])
      : []),
  ];
  return (
    <dl className="grid max-w-xl grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-muted">{label}</dt>
          <dd className="figure">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Lots({ detail }: { readonly detail: PositionDetail }) {
  return (
    <section aria-labelledby="lots" className="space-y-2">
      <h2 id="lots" className="font-semibold">
        Lots
      </h2>
      <TableRegion label="Lots">
        <table className="w-full min-w-lg border-y border-rule bg-surface text-sm">
          <caption className="sr-only">Lots, matched first in, first out</caption>
          <thead className="text-left text-ink-muted">
            <tr className="h-8 border-b border-rule">
              <th scope="col" className="px-3 font-medium">
                Bought
              </th>
              <th scope="col" className="px-3 font-medium">
                Sold
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Shares
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Cost
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Proceeds
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                P&amp;L
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {detail.lots.map((lot, index) => (
              <tr key={`${lot.entryDateIst}|${String(index)}`} className="h-8">
                <th scope="row" className="figure px-3 text-left font-normal">
                  {formatIstDate(lot.entryDateIst)}
                </th>
                <td className="figure px-3">
                  {lot.exitDateIst === null ? 'Held' : formatIstDate(lot.exitDateIst)}
                </td>
                <td className="figure px-3 text-right">{qty(lot.quantity)}</td>
                <td className="px-3 text-right">
                  <Money valueMicro={lot.entryValueMicro} />
                </td>
                <td className="px-3 text-right">
                  {lot.exitValueMicro === null ? '' : <Money valueMicro={lot.exitValueMicro} />}
                </td>
                <td className="px-3 text-right">
                  {lot.exitValueMicro === null ? (
                    ''
                  ) : (
                    <Money valueMicro={lot.exitValueMicro - lot.entryValueMicro} signed />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </section>
  );
}

function product(fill: PositionFill): string {
  const assigned = fill.bucket.toLowerCase();
  const declared = fill.trade?.productDeclared?.toLowerCase() ?? null;
  if (fill.inferred) return `${assigned} (inferred)`;
  if (declared === null || declared === assigned) return assigned;
  return `${assigned} (declared ${declared})`;
}

/** Where a fill came from; an imported trade discloses the broker's own row. */
function Source({ fill }: { readonly fill: PositionFill }) {
  const raw = fill.trade?.raw ?? null;
  if (fill.trade === null || raw === null) return <>{SOURCES[fill.source]}</>;
  return (
    <details>
      <summary className="cursor-pointer">Broker row ({fill.trade.exchange})</summary>
      <code className="mt-1 block font-mono text-xs break-all text-ink-muted">{raw}</code>
    </details>
  );
}

function Fills({ detail }: { readonly detail: PositionDetail }) {
  return (
    <section aria-labelledby="fills" className="space-y-2">
      <h2 id="fills" className="font-semibold">
        Fills
      </h2>
      <TableRegion label="Fills">
        <table className="w-full min-w-2xl border-y border-rule bg-surface text-sm">
          <caption className="sr-only">Fills, oldest first, with the broker's own row</caption>
          <thead className="text-left text-ink-muted">
            <tr className="h-8 border-b border-rule">
              <th scope="col" className="px-3 font-medium">
                When
              </th>
              <th scope="col" className="px-3 font-medium">
                Side
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Shares
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Price
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Value
              </th>
              <th scope="col" className="px-3 font-medium">
                Product
              </th>
              <th scope="col" className="px-3 font-medium">
                Source
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {detail.fills.map((fill) => (
              <tr key={fill.allocationId} className="h-8 align-top">
                <th scope="row" className="figure px-3 py-1.5 text-left font-normal">
                  {fill.trade === null ? SOURCES[fill.source] : formatIstDateTime(fill.trade.executedAtUtc)}
                </th>
                <td className="px-3 py-1.5">{fill.side === 'BUY' ? 'Buy' : 'Sell'}</td>
                <td className="figure px-3 py-1.5 text-right">{qty(fill.quantity)}</td>
                <td className="px-3 py-1.5 text-right">
                  {fill.trade === null ? '' : <Money valueMicro={fill.trade.priceMicro} />}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <Money valueMicro={fill.valueMicro} />
                </td>
                <td className="px-3 py-1.5">{product(fill)}</td>
                <td className="px-3 py-1.5">
                  <Source fill={fill} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </section>
  );
}

function Charges({ detail }: { readonly detail: PositionDetail }) {
  const lines = chargeLines(detail.charges);
  if (lines.length === 0) return null;
  return (
    <section aria-labelledby="charges" className="space-y-2">
      <h2 id="charges" className="font-semibold">
        Charges
      </h2>
      <TableRegion label="Charges">
        <table className="w-full min-w-lg border-y border-rule bg-surface text-sm">
          <caption className="sr-only">
            Charges: BhavBook's estimate, the broker's bill, and what counts
          </caption>
          <thead className="text-left text-ink-muted">
            <tr className="h-8 border-b border-rule">
              <th scope="col" className="px-3 font-medium">
                Charge
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Estimated
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Billed
              </th>
              <th scope="col" className="px-3 text-right font-medium">
                Counts
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {lines.map((line) => (
              <tr key={line.component} className="h-8">
                <th scope="row" className="px-3 text-left font-normal">
                  {COMPONENTS[line.component] ?? line.component}
                </th>
                <td className="px-3 text-right">
                  {line.estimatedMicro === null ? (
                    <span className="text-ink-muted">None</span>
                  ) : (
                    <Money valueMicro={line.estimatedMicro} />
                  )}
                </td>
                <td className="px-3 text-right">
                  {line.reportedMicro === null ? (
                    <span className="text-ink-muted">No statement</span>
                  ) : (
                    <Money valueMicro={line.reportedMicro} />
                  )}
                </td>
                <td className="px-3 text-right">
                  <Money valueMicro={line.effectiveMicro} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableRegion>
    </section>
  );
}

function Position({ detail }: { readonly detail: PositionDetail }) {
  const { position } = detail;
  const name = detail.instruments[position.instrumentKey] ?? position.instrumentKey;
  const opened = formatIstDate(istDateOf(position.openedAtUtc));
  const closed = position.closedAtUtc === null ? null : formatIstDate(istDateOf(position.closedAtUtc));
  return (
    <div className="max-w-5xl space-y-6">
      <div className="space-y-1">
        <p className="text-sm">
          <Link to="/review" className="text-primary underline-offset-4 hover:underline">
            Review queue
          </Link>
        </p>
        <h1 className="text-lg font-semibold">{name}</h1>
        <p className="text-sm text-ink-muted">
          {position.accountNickname} · {position.bucket.toLowerCase()} ·{' '}
          {closed === null ? `open since ${opened}` : `${opened} to ${closed}`}
        </p>
      </div>
      <Flags detail={detail} />
      <Figures detail={detail} />
      <Review detail={detail} />
      <Lots detail={detail} />
      <Fills detail={detail} />
      <Charges detail={detail} />
    </div>
  );
}
