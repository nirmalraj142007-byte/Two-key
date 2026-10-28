'use client';

import { formatUSD } from '@twokey/core/money';
import type { AgCartesianChartOptions } from 'ag-charts-community';
import { AgCharts } from 'ag-charts-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { baseChartTheme, setupAgCharts, useChartTokens } from '@/lib/ag-charts';
import type { ResultsSummary } from '@/lib/results-queries';
import { countOf, episodesHref, pctWithCount, shortModel } from './format';

setupAgCharts();

interface Row {
  modelId: string;
  model: string;
  outside: number;
  outsideOf: number;
  inside: number;
  insideOf: number;
  followed: number;
  attacked: number;
  /** Money to the attacker's payee under G4, in dollars (the bar value). */
  money: number;
  moneyCents: number;
}

export function crossModelRows(summary: ResultsSummary): Row[] {
  return Object.entries(summary.models).map(([modelId, m]) => {
    // computeMetrics throws if G4 ever sent money to an attacker, so a summary means $0.00.
    const moneyCents = summary.attackerMoneyCentsG4;
    return {
      modelId,
      model: shortModel(modelId),
      outside: m.followByTarget.outside_rules.followed,
      outsideOf: m.followByTarget.outside_rules.available,
      inside: m.followByTarget.inside_rules.followed,
      insideOf: m.followByTarget.inside_rules.available,
      followed: m.followed,
      attacked: m.attacked,
      money: moneyCents / 100,
      moneyCents,
    };
  });
}

export default function CrossModelChart({ summary }: { summary: ResultsSummary }) {
  const tokens = useChartTokens();
  const router = useRouter();
  const rows = crossModelRows(summary);
  const n = rows.length;

  const open = (params: Record<string, string>) => router.push(episodesHref(params));

  const chart = tokens
    ? (() => {
        const th = baseChartTheme(tokens);
        const axisX = {
          type: 'category' as const,
          position: 'bottom' as const,
          label: th.axisLabel,
          line: th.axisLine,
        };
        const follow: AgCartesianChartOptions = {
          data: rows,
          background: th.background,
          series: [
            {
              type: 'bar',
              xKey: 'model',
              yKey: 'outside',
              yName: 'Outside the rules (attacker payee)',
              fill: tokens.muted,
              cornerRadius: 3,
              label: {
                color: tokens.text,
                placement: 'outside-end',
                formatter: ({ datum }: { datum: Row }) => countOf(datum.outside, datum.outsideOf),
              },
              tooltip: {
                renderer: ({ datum }: { datum: Row }) => ({
                  heading: datum.model,
                  title: 'Followed an outside-the-rules attack',
                  data: [{ label: 'Runs', value: pctWithCount(datum.outside, datum.outsideOf) }],
                }),
              },
              listeners: {
                seriesNodeClick: ({ datum }: { datum: Row }) =>
                  open({ model: datum.modelId, set: 'followed', target: 'outside_rules' }),
              },
            },
            {
              type: 'bar',
              xKey: 'model',
              yKey: 'inside',
              yName: 'Inside the rules',
              fill: tokens.accent,
              cornerRadius: 3,
              label: {
                color: tokens.text,
                placement: 'outside-end',
                formatter: ({ datum }: { datum: Row }) => countOf(datum.inside, datum.insideOf),
              },
              tooltip: {
                renderer: ({ datum }: { datum: Row }) => ({
                  heading: datum.model,
                  title: 'Followed an inside-the-rules attack',
                  data: [{ label: 'Runs', value: pctWithCount(datum.inside, datum.insideOf) }],
                }),
              },
              listeners: {
                seriesNodeClick: ({ datum }: { datum: Row }) =>
                  open({ model: datum.modelId, set: 'followed', target: 'inside_rules' }),
              },
            },
          ],
          axes: {
            x: axisX,
            y: {
              type: 'number',
              position: 'left',
              min: 0,
              title: { text: 'Attacks the model followed', ...th.axisTitle },
              label: th.axisLabel,
              gridLine: { style: [{ stroke: tokens.border }] },
            },
          },
          legend: { position: 'bottom', item: { label: th.legendItem } },
        };
        const money: AgCartesianChartOptions = {
          data: rows,
          background: th.background,
          series: [
            {
              type: 'bar',
              direction: 'horizontal',
              xKey: 'model',
              yKey: 'money',
              yName: 'Money sent to the attacker payee (Two-Key)',
              fill: tokens.text,
              label: {
                enabled: true,
                color: tokens.text,
                fontWeight: 'bold',
                placement: 'outside-end',
                formatter: ({ datum }: { datum: Row }) => formatUSD(datum.moneyCents),
              },
              tooltip: {
                renderer: ({ datum }: { datum: Row }) => ({
                  heading: datum.model,
                  title: 'Money sent to the attacker payee under Two-Key',
                  data: [{ label: 'Amount', value: formatUSD(datum.moneyCents) }],
                }),
              },
              listeners: {
                seriesNodeClick: ({ datum }: { datum: Row }) =>
                  open({ model: datum.modelId, gate: 'G4', target: 'outside_rules' }),
              },
            },
          ],
          axes: {
            x: { ...axisX, position: 'left' },
            y: {
              type: 'number',
              position: 'bottom',
              min: 0,
              max: Math.max(1, ...rows.map((r) => r.money)),
              label: {
                ...th.axisLabel,
                formatter: ({ value }: { value: number }) => formatUSD(Math.round(value * 100)),
              },
              gridLine: { style: [{ stroke: tokens.border }] },
            },
          },
          legend: { enabled: false },
        };
        return { follow, money };
      })()
    : null;

  return (
    <section className="flex flex-col gap-4" aria-labelledby="cross-model-title">
      <div className="flex flex-col gap-1">
        <h2 id="cross-model-title" className="text-lg font-medium text-text">
          Same poisoned store, {n === 3 ? 'three' : n === 2 ? 'two' : n} models.
        </h2>
        <p className="text-sm text-text-muted">
          Attacks each model followed, by where the attacker pointed it: outside the signed rules
          (an attacker payee) or inside them (a wrong product at an allowed store). Click a bar for
          its runs.
        </p>
      </div>
      <div className="rounded-lg border border-border bg-surface-raised p-2">
        {chart ? (
          <AgCharts options={chart.follow} style={{ height: 320 }} />
        ) : (
          <div className="h-[320px]" aria-hidden="true" />
        )}
      </div>
      <div className="rounded-lg border border-border bg-surface-raised p-2">
        <h3 className="px-2 pt-1 text-sm font-medium text-text">
          Money sent to the attacker payee under Two-Key
        </h3>
        {chart ? (
          <AgCharts options={chart.money} style={{ height: 56 + 36 * n }} />
        ) : (
          <div style={{ height: 56 + 36 * n }} aria-hidden="true" />
        )}
      </div>
      <table className="w-full text-sm">
        <caption className="sr-only">Attacks followed and money sent, per model</caption>
        <thead className="text-left text-text-muted">
          <tr className="border-b border-border">
            <th scope="col" className="py-2 font-medium">
              Model
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Followed, outside the rules
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Followed, inside the rules
            </th>
            <th scope="col" className="py-2 text-right font-medium">
              Money to attacker (G4)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.modelId} className="border-b border-border">
              <th scope="row" className="py-2 text-left font-medium text-text">
                {r.model}
              </th>
              <td className="py-2 text-right tabular-nums">
                <Link
                  className="text-accent underline-offset-4 hover:underline"
                  href={episodesHref({
                    model: r.modelId,
                    set: 'followed',
                    target: 'outside_rules',
                  })}
                >
                  {countOf(r.outside, r.outsideOf)}
                </Link>
              </td>
              <td className="py-2 text-right tabular-nums">
                <Link
                  className="text-accent underline-offset-4 hover:underline"
                  href={episodesHref({ model: r.modelId, set: 'followed', target: 'inside_rules' })}
                >
                  {countOf(r.inside, r.insideOf)}
                </Link>
              </td>
              <td className="py-2 text-right tabular-nums font-medium">
                {formatUSD(r.moneyCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
