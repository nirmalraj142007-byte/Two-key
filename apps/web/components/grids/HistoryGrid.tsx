'use client';

import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  ICellRendererParams,
  RowHeightParams,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Money } from '@/components/twokey/money';
import { PayPalId, type PayPalIdKind } from '@/components/twokey/paypal-id';
import { STATE_LABEL, StateBadge } from '@/components/twokey/state-badge';
import { LoadingState } from '@/components/twokey/state-panels';
import { type AgGridSetup, gridTheme, setupAgGrid } from '@/lib/ag-grid';
import type { ProposalView } from '@/lib/console-view';
import {
  applyLive,
  awaitingText,
  type DisplayRow,
  displayRows,
  type GroupBy,
  type HistoryEvent,
  type HistoryRow,
  type HistoryState,
  type RuleChip,
  SOURCE_LABEL,
} from '@/lib/history-view';
import { cn } from '@/lib/utils';

/** What the page calls when a payment.updated event arrives. */
export interface HistoryGridHandle {
  onPaymentUpdated(view: ProposalView): void;
}

export interface HistoryGridProps {
  rows: HistoryRow[];
  handleRef: RefObject<HistoryGridHandle | null>;
  /** Called when an event names a row the grid doesn't have, or a row needs fresh events. */
  onStale: () => void;
}

const TIME = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const DECISION_LABEL: Record<NonNullable<HistoryRow['decision']>, string> = {
  capture: 'Capture',
  hold: 'Hold',
  block: 'Block',
  ask_every_time: 'Ask',
};

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'state', label: 'State' },
  { value: 'store', label: 'Store' },
];

// ---- cell renderers ---------------------------------------------------------------------

/** One second tick shared by every "awaiting PayPal" cell. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function StateCell({ row }: { row: HistoryRow }) {
  const now = useNow(awaitingText(row, Date.now()) !== null);
  const waiting = awaitingText(row, now);
  return (
    <span className="flex h-full items-center gap-2">
      <StateBadge state={row.state} label={row.state === 'blocked' ? 'Blocked' : undefined} />
      {row.state === 'blocked' ? (
        <span className="text-xs text-text-muted">No PayPal order created.</span>
      ) : null}
      {waiting ? <em className="text-xs text-text-muted">{waiting}</em> : null}
    </span>
  );
}

function Chips({ hits }: { hits: RuleChip[] }) {
  if (hits.length === 0) return <span className="text-text-muted">—</span>;
  return (
    <span
      className="flex h-full items-center gap-1 overflow-hidden whitespace-nowrap"
      title={hits.map((h) => h.label).join(', ')}
    >
      {hits.map((h) => (
        <span
          key={h.rule}
          data-kind={h.kind}
          className={cn(
            'inline-flex h-5 items-center rounded-full px-2 text-xs font-medium',
            h.kind === 'failed'
              ? 'bg-state-blocked-bg text-state-blocked-fg'
              : 'bg-state-held-bg text-state-held-fg',
          )}
        >
          {h.label}
        </span>
      ))}
    </span>
  );
}

function IdCell({ id, kind }: { id: string | null; kind: PayPalIdKind }) {
  if (!id) return <span className="text-text-muted">—</span>;
  return <PayPalId id={id} kind={kind} className="pl-0" />;
}

function Timeline({ row }: { row: HistoryRow }) {
  return (
    <div className="h-full overflow-auto bg-surface px-4 py-3" data-slot="payment-timeline">
      <p className="mb-2 text-xs font-medium text-text-muted">
        PayPal payment events · {row.product}
      </p>
      {row.events.length === 0 ? (
        <p className="text-sm text-text-muted">No payment events recorded yet.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-text-muted">
            <tr>
              <th className="py-1 pr-4 font-medium">Time</th>
              <th className="py-1 pr-4 font-medium">Source</th>
              <th className="py-1 pr-4 font-medium">Change</th>
              <th className="py-1 font-medium">PayPal event ID</th>
            </tr>
          </thead>
          <tbody>
            {row.events.map((e: HistoryEvent) => (
              <tr key={e.id} className="border-t border-border">
                <td className="py-1.5 pr-4 font-mono tabular-nums">
                  {TIME.format(new Date(e.at))}
                </td>
                <td className="py-1.5 pr-4">{SOURCE_LABEL[e.source]}</td>
                <td className="py-1.5 pr-4">
                  {e.from ?? '—'} → {e.to ?? '—'}
                  <span className="ml-2 text-text-muted">{e.type}</span>
                </td>
                <td className="py-1.5 font-mono text-text-muted">{e.paypalEventId ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function groupLabel(key: string, by: GroupBy): string {
  return by === 'state' && key in STATE_LABEL ? STATE_LABEL[key as HistoryState].label : key;
}

// ---- column definitions -------------------------------------------------------------------

function columns(opts: {
  enterprise: boolean;
  groupBy: GroupBy;
  toggle: (id: string) => void;
}): ColDef[] {
  const { enterprise, groupBy } = opts;
  // Community rows are DisplayRows; Enterprise rows are HistoryRows.
  const rowOf = (data: unknown): HistoryRow | undefined => {
    if (!data) return undefined;
    if (enterprise) return data as HistoryRow;
    const d = data as DisplayRow;
    return d.kind === 'group' ? undefined : d.row;
  };
  const field =
    <K extends keyof HistoryRow>(key: K) =>
    (p: { data?: unknown }) =>
      rowOf(p.data)?.[key];

  const cols: ColDef[] = [];
  if (!enterprise) {
    cols.push({
      colId: 'expand',
      headerName: '',
      width: 56,
      pinned: 'left',
      cellClass: 'flex items-center',
      cellRenderer: (p: ICellRendererParams) => {
        const d = p.data as DisplayRow | undefined;
        if (d?.kind !== 'row' || !d.row.paymentId) return null;
        const Icon = d.expanded ? ChevronDownIcon : ChevronRightIcon;
        return (
          <button
            type="button"
            aria-expanded={d.expanded}
            aria-label={`${d.expanded ? 'Hide' : 'Show'} payment events for ${d.row.product}`}
            onClick={() => opts.toggle(d.row.proposalId)}
            className="inline-flex size-7 items-center justify-center rounded-sm text-text-muted hover:bg-surface hover:text-text focus-visible:outline-2 focus-visible:outline-focus"
          >
            <Icon aria-hidden="true" className="size-4" />
          </button>
        );
      },
    });
  }
  cols.push(
    {
      colId: 'time',
      headerName: 'Time',
      valueGetter: field('createdAt'),
      valueFormatter: (p) => (p.value ? TIME.format(new Date(p.value as string)) : ''),
      width: 170,
      sort: enterprise ? 'desc' : undefined,
      cellClass: 'font-mono tabular-nums',
      ...(enterprise ? { cellRenderer: 'agGroupCellRenderer' } : {}),
    },
    {
      colId: 'product',
      headerName: 'Product',
      valueGetter: field('product'),
      flex: 1,
      minWidth: 180,
      tooltipValueGetter: (p) => p.value as string,
    },
    {
      colId: 'store',
      headerName: 'Store',
      valueGetter: field('store'),
      width: 150,
      ...(enterprise ? { rowGroup: groupBy === 'store', enableRowGroup: true } : {}),
    },
    {
      colId: 'amount',
      headerName: 'Amount',
      type: 'rightAligned',
      valueGetter: field('amountCents'),
      width: 110,
      cellRenderer: (p: ICellRendererParams) => {
        const r = rowOf(p.data);
        if (!r) return null;
        return (
          <span>
            <Money cents={r.amountCents} currency="USD" inGrid />
            {r.qty > 1 ? <span className="ml-1 text-text-muted">×{r.qty}</span> : null}
          </span>
        );
      },
    },
    {
      colId: 'decision',
      headerName: 'Decision',
      valueGetter: (p) => {
        const d = rowOf(p.data)?.decision;
        return d ? DECISION_LABEL[d] : '—';
      },
      width: 100,
    },
    {
      colId: 'ruleHits',
      headerName: 'Rule hits',
      valueGetter: (p) =>
        rowOf(p.data)
          ?.ruleHits.map((h) => h.label)
          .join(', ') ?? '',
      cellRenderer: (p: ICellRendererParams) => {
        const r = rowOf(p.data);
        return r ? <Chips hits={r.ruleHits} /> : null;
      },
      width: 330,
    },
    {
      colId: 'state',
      headerName: 'State',
      valueGetter: field('state'),
      cellRenderer: (p: ICellRendererParams) => {
        const r = rowOf(p.data);
        return r ? <StateCell row={r} /> : null;
      },
      width: 290,
      ...(enterprise ? { rowGroup: groupBy === 'state', enableRowGroup: true } : {}),
    },
    ...(
      [
        ['orderId', 'PayPal order', 'order'],
        ['authorizationId', 'Authorization', 'authorization'],
        ['captureId', 'Capture', 'capture'],
      ] as const
    ).map(
      ([key, headerName, kind]): ColDef => ({
        colId: key,
        headerName,
        valueGetter: field(key),
        width: 160,
        cellRenderer: (p: ICellRendererParams) => {
          const r = rowOf(p.data);
          return r ? <IdCell id={r[key]} kind={kind} /> : null;
        },
      }),
    ),
    {
      colId: 'lastSource',
      headerName: 'Last change',
      valueGetter: (p) => {
        const s = rowOf(p.data)?.lastSource;
        return s ? SOURCE_LABEL[s] : '—';
      },
      width: 130,
    },
    {
      colId: 'buyerPresent',
      headerName: 'Buyer present',
      valueGetter: (p) => {
        const r = rowOf(p.data);
        return r ? (r.buyerPresent ? 'yes' : 'no') : '';
      },
      width: 120,
    },
  );
  return cols;
}

// ---- the grid ------------------------------------------------------------------------------

/** Enterprise rows are HistoryRows; the Community fallback's are DisplayRows. */
type GridRow = HistoryRow | DisplayRow;

const DETAIL_BASE_PX = 76;
const DETAIL_ROW_PX = 30;
const ROW_PX = 44;

export default function HistoryGrid({ rows, handleRef, onStale }: HistoryGridProps) {
  const [setup, setSetup] = useState<AgGridSetup | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('state');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Bumped when a live update must regroup the Community fallback.
  const [version, setVersion] = useState(0);
  const apiRef = useRef<GridApi | null>(null);
  // Latest rows by proposal ID, including live updates applied since the last fetch.
  const live = useRef(new Map<string, HistoryRow>());

  useEffect(() => {
    let cancelled = false;
    void setupAgGrid().then((s) => {
      if (!cancelled) setSetup(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    live.current = new Map(rows.map((r) => [r.proposalId, r]));
  }, [rows]);

  const enterprise = setup?.enterprise ?? false;

  const toggle = useCallback((id: string) => {
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback((key: string) => {
    setCollapsed((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const columnDefs = useMemo(
    () => columns({ enterprise, groupBy, toggle }),
    [enterprise, groupBy, toggle],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: version re-reads the live map.
  const rowData = useMemo((): GridRow[] => {
    const current = rows.map((r) => live.current.get(r.proposalId) ?? r);
    return enterprise ? current : displayRows(current, groupBy, collapsed, expanded);
  }, [rows, enterprise, groupBy, collapsed, expanded, version]);

  useEffect(() => {
    handleRef.current = {
      onPaymentUpdated(view) {
        const row = live.current.get(view.proposalId);
        if (!row) {
          onStale();
          return;
        }
        const next = applyLive(row, view, new Date());
        if (!next) return;
        live.current.set(next.proposalId, next);
        const api = apiRef.current;
        if (enterprise) {
          api?.applyTransactionAsync({ update: [next] });
        } else if (groupBy === 'state' && next.state !== row.state) {
          setVersion((v) => v + 1);
        } else {
          const open = expanded.has(next.proposalId);
          const update: DisplayRow[] = [
            { kind: 'row', id: next.proposalId, row: next, expanded: open },
          ];
          if (open) update.push({ kind: 'detail', id: `detail:${next.proposalId}`, row: next });
          api?.applyTransactionAsync({ update });
        }
        // Pull the new payment events (and last-change source) shortly after.
        onStale();
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, onStale, enterprise, groupBy, expanded]);

  const getRowId = useCallback(
    (p: GetRowIdParams) =>
      enterprise ? (p.data as HistoryRow).proposalId : (p.data as DisplayRow).id,
    [enterprise],
  );

  const getRowHeight = useCallback(
    (p: RowHeightParams) => {
      if (enterprise) return undefined;
      const d = p.data as DisplayRow | undefined;
      if (d?.kind === 'detail') {
        return DETAIL_BASE_PX + DETAIL_ROW_PX * Math.max(1, d.row.events.length);
      }
      return ROW_PX;
    },
    [enterprise],
  );

  const fullWidth = useCallback(
    (p: ICellRendererParams) => {
      const d = p.data as DisplayRow;
      if (d.kind === 'detail') return <Timeline row={d.row} />;
      if (d.kind !== 'group') return null;
      const Icon = d.open ? ChevronDownIcon : ChevronRightIcon;
      return (
        <button
          type="button"
          aria-expanded={d.open}
          onClick={() => toggleGroup(d.key)}
          className="flex h-full w-full items-center gap-2 bg-surface px-3 text-left text-sm font-medium text-text hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus"
        >
          <Icon aria-hidden="true" className="size-4 text-text-muted" />
          {groupLabel(d.key, groupBy)}
          <span className="font-normal text-text-muted">
            {d.count} {d.count === 1 ? 'purchase' : 'purchases'} ·{' '}
            <Money cents={d.totalCents} currency="USD" inGrid /> proposed
          </span>
        </button>
      );
    },
    [groupBy, toggleGroup],
  );

  const DetailRenderer = useCallback(
    (p: ICellRendererParams) => <Timeline row={p.data as HistoryRow} />,
    [],
  );

  if (!setup) return <LoadingState rows={4} />;

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="flex items-center gap-2 text-sm">
        <legend className="sr-only">Group rows by</legend>
        <span className="text-text-muted" aria-hidden="true">
          Group by
        </span>
        <div className="inline-flex rounded-md border border-border bg-surface p-0.5">
          {GROUP_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              aria-pressed={groupBy === o.value}
              onClick={() => {
                setGroupBy(o.value);
                setCollapsed(new Set());
              }}
              className={cn(
                'h-8 min-w-16 rounded-sm px-3 text-sm focus-visible:outline-2 focus-visible:outline-focus',
                groupBy === o.value
                  ? 'bg-surface-raised font-medium text-text shadow-xs'
                  : 'text-text-muted hover:text-text',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="h-[70vh] min-h-[420px] w-full" data-testid="history-grid">
        <AgGridReact<GridRow>
          theme={gridTheme}
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={{
            sortable: enterprise,
            resizable: true,
            suppressHeaderMenuButton: !enterprise,
          }}
          getRowId={getRowId}
          onGridReady={(e: GridReadyEvent) => {
            apiRef.current = e.api;
          }}
          suppressCellFocus={false}
          tooltipShowDelay={400}
          {...(enterprise
            ? {
                groupDisplayType: 'singleColumn' as const,
                groupDefaultExpanded: -1,
                masterDefaultExpanded: 0,
                autoGroupColumnDef: { headerName: 'Group', minWidth: 200 },
                masterDetail: true,
                isRowMaster: (r: GridRow) => (r as HistoryRow).paymentId !== null,
                detailCellRenderer: DetailRenderer,
                detailRowAutoHeight: true,
              }
            : {
                isFullWidthRow: (p: { rowNode: { data?: GridRow } }) =>
                  (p.rowNode.data as DisplayRow | undefined)?.kind !== 'row',
                fullWidthCellRenderer: fullWidth,
                getRowHeight,
              })}
        />
      </div>
    </div>
  );
}
