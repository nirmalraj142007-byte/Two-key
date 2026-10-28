'use client';

import type {
  CellKeyDownEvent,
  ColDef,
  ICellRendererParams,
  RowClickedEvent,
} from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { OUTCOME_LABEL, OutcomeChip } from '@/components/results/OutcomeChip';
import { LoadingState } from '@/components/twokey/state-panels';
import { type AgGridSetup, gridTheme, setupAgGrid } from '@/lib/ag-grid';
import { type EpisodeRow, GATE_IDS, type Outcome } from '@/lib/episodes-view';

/**
 * Evaluation runs, one row per episode × model. Enterprise groups rows by model, variant and
 * G4 outcome; the Community fallback is a flat, sortable list. A row opens its episode.
 * Load with next/dynamic ({ ssr: false }).
 */

const VARIANT_LABEL: Record<EpisodeRow['variant'], string> = {
  clean: 'Clean',
  injecagent: 'InjecAgent',
  agentdojo: 'AgentDojo',
};
const TARGET_LABEL = { outside_rules: 'Outside the rules', inside_rules: 'Inside the rules' };

const shortModel = (m: string) => m.slice(m.indexOf('/') + 1);
const outcomeText = (o: Outcome | null) => (o ? OUTCOME_LABEL[o] : 'No proposal');

function columns(enterprise: boolean): ColDef<EpisodeRow>[] {
  const group = (on: boolean): Partial<ColDef<EpisodeRow>> =>
    enterprise ? { enableRowGroup: true, rowGroup: on, hide: on } : {};
  return [
    {
      colId: 'model',
      headerName: 'Model',
      valueGetter: (p) => (p.data ? shortModel(p.data.model) : undefined),
      width: 190,
      ...group(true),
    },
    {
      colId: 'variant',
      headerName: 'Variant',
      valueGetter: (p) => (p.data ? VARIANT_LABEL[p.data.variant] : undefined),
      width: 120,
      ...group(true),
    },
    {
      colId: 'g4group',
      headerName: 'G4 outcome',
      valueGetter: (p) => (p.data ? outcomeText(p.data.g4) : undefined),
      width: 130,
      hide: true,
      ...group(true),
    },
    {
      colId: 'task',
      headerName: 'Task',
      valueGetter: (p) => p.data?.taskId.slice(-8),
      width: 110,
      cellClass: 'font-mono tabular-nums',
      tooltipValueGetter: (p) => p.data?.taskId,
    },
    {
      colId: 'target',
      headerName: 'Attack goal',
      valueGetter: (p) =>
        p.data?.targetType
          ? `${TARGET_LABEL[p.data.targetType]}${p.data.targetFallback ? ' (fallback)' : ''}`
          : '—',
      width: 160,
    },
    {
      colId: 'followed',
      headerName: 'Followed',
      valueGetter: (p) =>
        p.data ? (p.data.variant === 'clean' ? '—' : p.data.followed ? 'Yes' : 'No') : undefined,
      width: 100,
    },
    ...GATE_IDS.map(
      (g): ColDef<EpisodeRow> => ({
        colId: g,
        headerName: g,
        valueGetter: (p) => (p.data ? p.data[g.toLowerCase() as 'g0'] : undefined),
        width: 104,
        cellClass: 'flex items-center',
        cellRenderer: (p: ICellRendererParams<EpisodeRow>) =>
          p.data ? <OutcomeChip outcome={p.data[g.toLowerCase() as 'g0']} /> : null,
      }),
    ),
    {
      colId: 'proposal',
      headerName: 'Proposal',
      valueGetter: (p) => p.data?.proposalTitle ?? '—',
      flex: 1,
      minWidth: 220,
      tooltipValueGetter: (p) => p.value as string,
    },
    {
      colId: 'cost',
      headerName: 'LLM cost',
      type: 'rightAligned',
      valueGetter: (p) => p.data?.costUsd,
      valueFormatter: (p) => (typeof p.value === 'number' ? `$${p.value.toFixed(4)}` : ''),
      width: 110,
      cellClass: 'tabular-nums',
    },
  ];
}

export default function EpisodesGrid({ rows }: { rows: EpisodeRow[] }) {
  const router = useRouter();
  const [setup, setSetup] = useState<AgGridSetup | null>(null);

  useEffect(() => {
    let cancelled = false;
    void setupAgGrid().then((s) => {
      if (!cancelled) setSetup(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const enterprise = setup?.enterprise ?? false;
  const columnDefs = useMemo(() => columns(enterprise), [enterprise]);
  const open = (row: EpisodeRow | undefined) => {
    if (row) router.push(`/results/episodes/${row.episodeId}`);
  };

  if (!setup) return <LoadingState rows={4} />;

  return (
    <div className="h-[70vh] min-h-[420px] w-full" data-testid="episodes-grid">
      <AgGridReact<EpisodeRow>
        theme={gridTheme}
        rowData={rows}
        columnDefs={columnDefs}
        getRowId={(p) => p.data.runId}
        defaultColDef={{ sortable: true, resizable: true }}
        rowClass="cursor-pointer"
        onRowClicked={(e: RowClickedEvent<EpisodeRow>) => open(e.data)}
        onCellKeyDown={(e: CellKeyDownEvent<EpisodeRow>) => {
          if ((e.event as KeyboardEvent | null)?.key === 'Enter') open(e.data);
        }}
        tooltipShowDelay={400}
        {...(enterprise
          ? {
              groupDefaultExpanded: 1,
              rowGroupPanelShow: 'always' as const,
              autoGroupColumnDef: { headerName: 'Group', minWidth: 260 },
            }
          : {})}
      />
    </div>
  );
}
