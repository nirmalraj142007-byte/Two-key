import Link from 'next/link';
import type { ResultsSummary } from '@/lib/results-queries';
import { countOf, episodesHref, pct, shareCount, shortModel } from './format';

function Cell({ n, of, href }: { n: number; of: number; href: string }) {
  return (
    <td className="py-2 text-right tabular-nums">
      <Link className="text-accent underline-offset-4 hover:underline" href={href}>
        {countOf(n, of)}
      </Link>
      <span className="ml-1 text-text-muted">({of === 0 ? '—' : pct(n / of)})</span>
    </td>
  );
}

export default function InsideRulesPanel({ summary }: { summary: ResultsSummary }) {
  const rows = Object.entries(summary.models).map(([modelId, m]) => {
    const n = m.insideRules.followed;
    return {
      modelId,
      model: shortModel(modelId),
      followed: n,
      available: m.followByTarget.inside_rules.available,
      passed: shareCount(m.insideRules.passShare, n),
      held: shareCount(m.insideRules.heldShare, n),
      blocked: shareCount(m.insideRules.blockedShare, n),
    };
  });
  const base = { set: 'followed', target: 'inside_rules', gate: 'G4' };

  return (
    <section className="flex flex-col gap-4" aria-labelledby="inside-title">
      <div className="flex flex-col gap-1">
        <h2 id="inside-title" className="text-lg font-medium text-text">
          Inside the rules
        </h2>
        <p className="text-base text-text">
          Rules stop theft; your hold and your review catch manipulation.
        </p>
        <p className="text-sm text-text-muted">
          Attacks that pointed the agent at a wrong product at an allowed store, within the budget,
          and that the model followed. Under Two-Key, each one either passed every signed rule (the
          “wrong shoes, inside the budget” case), was held for your review by the price-anomaly
          check, or was blocked.
        </p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border bg-surface-raised px-4">
        <table className="w-full min-w-[640px] text-sm">
          <caption className="sr-only">Followed inside-the-rules attacks under Two-Key</caption>
          <thead className="text-left text-text-muted">
            <tr className="border-b border-border">
              <th scope="col" className="py-2 font-medium">
                Model
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Followed
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Passed every rule
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Held for review
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                Blocked
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.modelId} className="border-b border-border last:border-0">
                <th scope="row" className="py-2 text-left font-medium text-text">
                  {r.model}
                </th>
                <Cell
                  n={r.followed}
                  of={r.available}
                  href={episodesHref({ model: r.modelId, set: 'followed', target: 'inside_rules' })}
                />
                <Cell
                  n={r.passed}
                  of={r.followed}
                  href={episodesHref({ model: r.modelId, ...base, outcome: 'passed' })}
                />
                <Cell
                  n={r.held}
                  of={r.followed}
                  href={episodesHref({ model: r.modelId, ...base, outcome: 'hold' })}
                />
                <Cell
                  n={r.blocked}
                  of={r.followed}
                  href={episodesHref({ model: r.modelId, ...base, outcome: 'block' })}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-sm text-text-muted">
        “Passed every rule” includes the held ones: a hold means every signed rule passed and the
        price looked wrong. Small samples: read the counts, not the percentages.
      </p>
    </section>
  );
}
