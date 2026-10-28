import type { CheckpointView, PredictionView, ResultsSummary } from '@/lib/results-queries';
import { cn } from '@/lib/utils';
import { countOf, pct, shortModel } from './format';

const METRIC_LABEL: Record<string, string> = {
  followRate: 'Follow rate, all attacks',
  outsideFollowRate: 'Follow rate, outside the rules',
  insideFollowRate: 'Follow rate, inside the rules',
  honestInterrupted: 'Honest purchases interrupted',
  insideRulesHeldShare: 'Followed inside-rules attacks held',
};

const day = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

function Checkpoint({ c }: { c: CheckpointView }) {
  let status: string;
  if (c.id === 'dev') {
    status = c.result
      ? `${shortModel(c.result.model)} followed ${countOf(c.result.followed, c.result.attacked)} dev attacks: ${c.result.passed ? 'passed' : 'not met'}`
      : 'after the dev run';
  } else {
    status = c.verifiedAt ? `${c.evidence} (${day(c.verifiedAt)})` : 'pending';
  }
  return (
    <li className="flex flex-col gap-0.5 border-b border-border py-2 last:border-0 sm:flex-row sm:gap-4">
      <span className="w-16 shrink-0 tabular-nums text-text-muted">{day(c.gate)}</span>
      <span className="flex flex-col">
        <span className="font-medium text-text">{c.label}</span>
        <span className="text-text-muted">
          {c.criterion}. {status}
        </span>
      </span>
    </li>
  );
}

function PredictionRow({ p }: { p: PredictionView }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2">{METRIC_LABEL[p.metric] ?? p.metric}</td>
      <td className="py-2">{p.model ? shortModel(p.model) : '—'}</td>
      <td className="py-2">{p.gate ?? '—'}</td>
      <td className="py-2 text-right tabular-nums">
        {pct(p.low)}–{pct(p.high)}
      </td>
      <td className="py-2 text-right tabular-nums">
        {p.actual === null ? (
          <span className="text-text-muted">after the test run</span>
        ) : (
          pct(p.actual)
        )}
      </td>
      <td
        className={cn(
          'py-2 pl-4 text-right',
          p.hit === false && 'font-medium text-state-blocked-fg',
          p.hit === null && 'text-text-muted',
        )}
      >
        {p.hit === null ? '—' : p.hit ? 'Hit' : 'Miss'}
      </td>
    </tr>
  );
}

export default function PredictionsPanel({ summary }: { summary: ResultsSummary }) {
  const { predictions, checkpoints, repoUrl } = summary;
  const sha = predictions.registeredCommit;
  return (
    <section className="flex flex-col gap-6" aria-labelledby="predictions-title">
      <div className="flex flex-col gap-1">
        <h2 id="predictions-title" className="text-lg font-medium text-text">
          Predictions
        </h2>
        {sha && predictions.registeredAt ? (
          <p className="text-base text-text">
            Registered {day(predictions.registeredAt)} at commit{' '}
            <a
              className="font-mono text-accent underline-offset-4 hover:underline"
              href={`${repoUrl}/commit/${sha}`}
              target="_blank"
              rel="noreferrer"
            >
              {sha.slice(0, 7)}
            </a>
            , before any test run. Ranges are shares of runs.
          </p>
        ) : (
          <p className="text-sm text-text-muted">No predictions are registered yet.</p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-text">Dated checkpoints</h3>
        <ol className="rounded-lg border border-border bg-surface-raised px-4 text-sm">
          {checkpoints.map((c) => (
            <Checkpoint key={c.id} c={c} />
          ))}
        </ol>
      </div>

      {predictions.rows.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border border-border bg-surface-raised px-4">
          <table className="w-full min-w-[720px] text-sm">
            <caption className="sr-only">Registered predictions and test results</caption>
            <thead className="text-left text-text-muted">
              <tr className="border-b border-border">
                <th scope="col" className="py-2 font-medium">
                  Metric
                </th>
                <th scope="col" className="py-2 font-medium">
                  Model
                </th>
                <th scope="col" className="py-2 font-medium">
                  Gate
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Predicted range
                </th>
                <th scope="col" className="py-2 text-right font-medium">
                  Actual
                </th>
                <th scope="col" className="py-2 pl-4 text-right font-medium">
                  Hit
                </th>
              </tr>
            </thead>
            <tbody>
              {predictions.rows.map((p) => (
                <PredictionRow key={`${p.metric}-${p.model}-${p.gate}`} p={p} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
