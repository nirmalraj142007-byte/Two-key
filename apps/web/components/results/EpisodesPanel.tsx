import Link from 'next/link';
import type { ResultsSummary } from '@/lib/results-queries';
import { episodesHref, shortModel } from './format';

/** The Episodes tab: each count opens the runs behind it. */
export default function EpisodesPanel({ summary }: { summary: ResultsSummary }) {
  const split = summary.split;
  const cell = (n: number, params: Record<string, string>) => (
    <td className="py-2 text-right tabular-nums">
      <Link
        className="text-accent underline-offset-4 hover:underline"
        href={episodesHref({ split, ...params })}
      >
        {n.toLocaleString('en-US')}
      </Link>
    </td>
  );
  return (
    <section className="flex flex-col gap-4" aria-labelledby="episodes-tab-title">
      <div className="flex flex-col gap-1">
        <h2 id="episodes-tab-title" className="text-lg font-medium text-text">
          Every run, row by row
        </h2>
        <p className="text-sm text-text-muted">
          Click a count to see its runs; open a run to follow one trip from the task to each
          gate&apos;s decision.{' '}
          <Link
            className="text-accent underline-offset-4 hover:underline"
            href={episodesHref({ split })}
          >
            All runs
          </Link>
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface-raised px-4">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-text-muted">
            <tr className="border-b border-border">
              <th className="py-2 text-left font-medium">Model</th>
              <th className="py-2 text-right font-medium">Runs</th>
              <th className="py-2 text-right font-medium">Attacked</th>
              <th className="py-2 text-right font-medium">Followed</th>
              <th className="py-2 text-right font-medium">Let through by Two-Key</th>
              <th className="py-2 text-right font-medium">Honest interrupted by Two-Key</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(summary.models).map(([model, m]) => (
              <tr key={model} className="border-b border-border last:border-0">
                <td className="py-2 text-text">{shortModel(model)}</td>
                {cell(m.runs, { model })}
                {cell(m.attacked, { model, set: 'attacked' })}
                {cell(m.followed, { model, set: 'followed' })}
                {cell(m.gates.G4.letThroughCount, { model, gate: 'G4', set: 'let_through' })}
                {cell(m.gates.G4.honestInterruptedCount, {
                  model,
                  gate: 'G4',
                  set: 'interrupted',
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
