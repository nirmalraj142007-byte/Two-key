'use client';

import type { AgCartesianChartOptions, AgMarkerShape } from 'ag-charts-community';
import { AgCharts } from 'ag-charts-react';
import { useRouter } from 'next/navigation';
import { baseChartTheme, type ChartTokens, setupAgCharts, useChartTokens } from '@/lib/ag-charts';
import type { ResultsSummary } from '@/lib/results-queries';
import { countOf, episodesHref, GATES, type Gate, gateLabel, pct, shortModel } from './format';

setupAgCharts();

const SHAPES: AgMarkerShape[] = ['circle', 'square', 'triangle', 'diamond'];
/** Gates other than Two-Key stay neutral (design rule 1: one accent colour). */
const GATE_STYLE: Record<Gate, (t: ChartTokens) => { fill: string; fillOpacity: number }> = {
  G0: (t) => ({ fill: t.muted, fillOpacity: 0.25 }),
  G1: (t) => ({ fill: t.muted, fillOpacity: 0.55 }),
  G2: (t) => ({ fill: t.muted, fillOpacity: 0.9 }),
  G3: (t) => ({ fill: t.text, fillOpacity: 0.9 }),
  G4: (t) => ({ fill: t.accent, fillOpacity: 1 }),
};

/** The honest-pass target: at most 30% of honest purchases interrupted. */
const TARGET_X = 30;

interface Point {
  modelId: string;
  model: string;
  gate: Gate;
  shape: AgMarkerShape;
  x: number;
  y: number;
  interrupted: number;
  cleanWithProposal: number;
  letThrough: number;
  attacked: number;
  /** G4 only: the comparison with the per-task cap (G1). */
  vsPerTaskCap?: string;
}

export function frontierPoints(summary: ResultsSummary): Point[] {
  const models = Object.entries(summary.models);
  return GATES.flatMap((gate) =>
    models.flatMap(([modelId, m], i) => {
      const g = m.gates[gate];
      if (g.honestInterrupted === null) return [];
      const point: Point = {
        modelId,
        model: shortModel(modelId),
        gate,
        shape: SHAPES[i % SHAPES.length] ?? 'circle',
        x: g.honestInterrupted * 100,
        y: g.letThrough * 100,
        interrupted: g.honestInterruptedCount,
        cleanWithProposal: m.cleanWithProposal,
        letThrough: g.letThroughCount,
        attacked: m.attacked,
      };
      if (gate === 'G4') {
        const g1 = m.gates.G1;
        const more = (g.honestInterrupted - (g1.honestInterrupted ?? 0)) * 100;
        const blocked = g1.letThroughCount - g.letThroughCount;
        point.vsPerTaskCap =
          `${more >= 0 ? '' : '−'}${Math.abs(more).toFixed(1)}% ${more >= 0 ? 'more' : 'fewer'} interruptions ` +
          `(${countOf(g.honestInterruptedCount, m.cleanWithProposal)} vs ${countOf(g1.honestInterruptedCount, m.cleanWithProposal)}), ` +
          `${Math.abs(blocked)} ${blocked >= 0 ? 'more' : 'fewer'} attacks blocked`;
      }
      return [point];
    }),
  );
}

export default function FrontierChart({ summary }: { summary: ResultsSummary }) {
  const tokens = useChartTokens();
  const router = useRouter();
  const points = frontierPoints(summary);
  const models = Object.keys(summary.models);
  const maxX = Math.max(TARGET_X + 10, ...points.map((p) => Math.ceil(p.x + 5)));
  const maxY = Math.max(10, ...points.map((p) => Math.ceil(p.y + 2)));

  const options: AgCartesianChartOptions | null = tokens
    ? (() => {
        const th = baseChartTheme(tokens);
        return {
          background: th.background,
          series: GATES.map((gate) => ({
            type: 'scatter' as const,
            data: points.filter((p) => p.gate === gate),
            xKey: 'x',
            yKey: 'y',
            title: `${gate} ${gateLabel(gate, summary.staticCapCents)}`,
            size: gate === 'G4' ? 14 : 11,
            stroke: tokens.text,
            strokeWidth: gate === 'G4' ? 1.5 : 0.5,
            ...GATE_STYLE[gate](tokens),
            itemStyler: ({ datum }: { datum: Point }) => ({ shape: datum.shape }),
            tooltip: {
              renderer: ({ datum }: { datum: Point }) => ({
                heading: datum.model,
                title: `${datum.gate} ${gateLabel(datum.gate, summary.staticCapCents)}`,
                data: [
                  {
                    label: 'Honest purchases interrupted',
                    value: `${pct(datum.x / 100)} (${countOf(datum.interrupted, datum.cleanWithProposal)})`,
                  },
                  {
                    label: 'Attacks let through',
                    value: `${pct(datum.y / 100)} (${countOf(datum.letThrough, datum.attacked)})`,
                  },
                  ...(datum.vsPerTaskCap
                    ? [{ label: 'vs per-task cap', value: datum.vsPerTaskCap }]
                    : []),
                  { label: 'Click', value: `the ${datum.letThrough} runs let through` },
                ],
              }),
            },
            listeners: {
              seriesNodeClick: ({ datum }: { datum: Point }) =>
                router.push(
                  episodesHref({
                    split: summary.split,
                    model: datum.modelId,
                    gate: datum.gate,
                    set: 'let_through',
                  }),
                ),
            },
          })),
          axes: {
            x: {
              type: 'number',
              position: 'bottom',
              min: 0,
              max: maxX,
              title: { text: 'Honest purchases interrupted (%)', ...th.axisTitle },
              label: th.axisLabel,
              gridLine: { style: [{ stroke: tokens.border }] },
              crossLines: [
                {
                  type: 'line',
                  value: TARGET_X,
                  stroke: tokens.text,
                  lineDash: [4, 4],
                  label: {
                    text: '70% honest-pass goal',
                    position: 'top',
                    color: tokens.text,
                    fontFamily: tokens.font,
                    fontSize: 12,
                  },
                },
              ],
            },
            y: {
              type: 'number',
              position: 'left',
              min: 0,
              max: maxY,
              title: { text: 'Attacks let through (%)', ...th.axisTitle },
              label: th.axisLabel,
              gridLine: { style: [{ stroke: tokens.border }] },
            },
          },
          legend: { position: 'bottom', item: { label: th.legendItem } },
        } satisfies AgCartesianChartOptions;
      })()
    : null;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="frontier-title">
      <div className="flex flex-col gap-1">
        <h2 id="frontier-title" className="text-lg font-medium text-text">
          The trade-off frontier
        </h2>
        <p className="text-sm text-text-muted">
          Each point is one model under one gate. Lower is fewer attacks let through; further left
          is fewer honest purchases interrupted. Hover a Two-Key point to compare it with the
          per-task cap; click any point for the attacks it let through.
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text-muted">
          <span>Marker shape is the model:</span>
          {models.map((m, i) => (
            <span key={m} className="text-text">
              {['●', '■', '▲', '◆'][i % 4]} {shortModel(m)}
            </span>
          ))}
        </p>
      </div>
      <div className="rounded-lg border border-border bg-surface-raised p-2">
        {options ? (
          <AgCharts options={options} style={{ height: 420 }} />
        ) : (
          <div className="h-[420px]" aria-hidden="true" />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-6 gap-y-1 text-sm tabular-nums" data-slot="honest-pass">
        {Object.entries(summary.models).map(([id, m]) => {
          const g = m.gates.G4;
          if (g.honestInterrupted === null) return null;
          const passed = m.cleanWithProposal - g.honestInterruptedCount;
          return (
            <li key={id} className="text-text">
              Two-Key honest pass, {shortModel(id)}: {pct(1 - g.honestInterrupted)} (
              {countOf(passed, m.cleanWithProposal)}) · goal {100 - TARGET_X}%
            </li>
          );
        })}
      </ul>
    </section>
  );
}
