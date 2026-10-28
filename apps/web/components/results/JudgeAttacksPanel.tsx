import { formatUSD } from '@twokey/core/money';
import { Banner } from '@/components/twokey/banner';
import { EmptyState, ErrorState } from '@/components/twokey/state-panels';
import { getJudgeAttacks, JUDGE_ROWS_SHOWN, type JudgeAttacksSummary } from '@/lib/hijack-queries';
import { countOf } from './format';

const STATUS_TEXT: Record<JudgeAttacksSummary['rows'][number]['status'], string> = {
  running: 'Running',
  done: 'Live',
  replayed: 'Replay shown',
  failed: 'Failed',
};

const BANNER =
  'Judge-written attacks: a separate, unvetted dataset from the public hijack box. Anyone can submit text; it is not part of the evaluation and none of its numbers appear above.';

function followedText(v: boolean | null): string {
  if (v === null) return '—';
  return v ? 'Yes' : 'No';
}

/** The hijack box's attempts: a separate, unvetted dataset. Text is shown as text only. */
export default async function JudgeAttacksPanel() {
  let s: JudgeAttacksSummary;
  try {
    s = await getJudgeAttacks();
  } catch {
    return (
      <ErrorState
        title="Judge-written attacks could not load"
        body="The attempts are unavailable right now."
      />
    );
  }
  if (s.total === 0) {
    return (
      <div className="flex flex-col gap-4">
        <Banner tone="info" text={BANNER} />
        <EmptyState
          title="No attempts yet"
          body="Attempts from the hijack box appear here, redacted and shortened."
        />
      </div>
    );
  }
  const o = s.outcomes;
  return (
    <section aria-labelledby="judge-title" className="flex flex-col gap-4">
      <h2 id="judge-title" className="sr-only">
        Judge-written attacks
      </h2>
      <Banner tone="info" text={BANNER} />
      <ul className="grid gap-3 text-sm md:grid-cols-3">
        <li className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-4">
          <span className="font-medium text-text">Followed the text (live runs)</span>
          <span className="tabular-nums text-text">{countOf(s.followed, s.liveFinished)}</span>
          <span className="text-xs text-text-muted">
            Not counted: {s.replayed.toLocaleString('en-US')} shown as a replay,{' '}
            {s.failed.toLocaleString('en-US')} failed.
          </span>
        </li>
        <li className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-4">
          <span className="font-medium text-text">Gate outcomes (live proposals)</span>
          <span className="tabular-nums text-text">
            Bought {o.captured} · Held {o.held} · Blocked {o.blocked} · Not purchased {o.failed}
          </span>
        </li>
        <li className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-4">
          <span className="font-medium text-text">Money moved to an attacker</span>
          <span className="tabular-nums text-text">{formatUSD(s.attackerCents)}</span>
        </li>
      </ul>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Latest {JUDGE_ROWS_SHOWN} attempts, newest first</caption>
          <thead className="bg-surface text-xs text-text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                When (UTC)
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Text (redacted, shortened)
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Run
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Followed
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Gate
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                To attacker
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {s.rows.map((r) => (
              <tr key={r.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-muted">
                  {r.createdAt.slice(0, 16).replace('T', ' ')}
                </td>
                <td className="max-w-[28rem] whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs text-text">
                  {r.text}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-text">{STATUS_TEXT[r.status]}</td>
                <td className="px-3 py-2 text-text">{followedText(r.followed)}</td>
                <td className="px-3 py-2 text-text">
                  {r.decisions.length === 0 ? '—' : r.decisions.join('; ')}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-text">
                  {r.status === 'done' ? formatUSD(r.attackerCents) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
