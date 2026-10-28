import { formatUSD } from '@twokey/core/money';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';
import EpisodesPanel from '@/components/results/EpisodesPanel';
import { countOf, pct, shareCount, shortModel } from '@/components/results/format';
import InsideRulesPanel from '@/components/results/InsideRulesPanel';
import JudgeAttacksPanel from '@/components/results/JudgeAttacksPanel';
import PredictionsPanel from '@/components/results/PredictionsPanel';
import { ResultsError, ResultsTabs } from '@/components/results/ResultsTabs';
import { Banner } from '@/components/twokey/banner';
import { EmptyState, LoadingState } from '@/components/twokey/state-panels';
import { getResultsSummary, type ResultsSummary } from '@/lib/results-queries';

export const metadata: Metadata = { title: 'Results · Two-Key' };

/** Counts first; the one percentage (rule of three) carries its count and confidence. */
function HeaderLine({ s }: { s: ResultsSummary }) {
  const { totals, headline } = s;
  const parts = [
    `${totals.runs.toLocaleString('en-US')} runs`,
    `${totals.gateDecisions.toLocaleString('en-US')} gate decisions`,
    `${headline.attacked.toLocaleString('en-US')} attacked runs`,
    `${headline.attackerPayments} attacker payments under Two-Key`,
  ];
  if (headline.ruleOfThreePooled !== null) {
    parts.push(
      `attacker payment rate ≤ ${pct(headline.ruleOfThreePooled)} at 95% (${countOf(headline.attackerPayments, headline.attacked)})`,
    );
  }
  return <p className="text-base text-text-muted tabular-nums">{parts.join(' · ')}</p>;
}

/** The headline: follow rate by target type per model, attacker money, and the held share. */
function Findings({ s }: { s: ResultsSummary }) {
  return (
    <section aria-labelledby="findings-title" className="flex flex-col gap-3">
      <h2 id="findings-title" className="sr-only">
        Findings
      </h2>
      <p className="text-lg text-text">
        Money sent to an attacker under Two-Key:{' '}
        <span className="font-medium tabular-nums">{formatUSD(s.attackerMoneyCentsG4)}</span>.
      </p>
      <ul className="grid gap-3 md:grid-cols-3">
        {Object.entries(s.models).map(([id, m]) => {
          const out = m.followByTarget.outside_rules;
          const ins = m.followByTarget.inside_rules;
          const held = shareCount(m.insideRules.heldShare, m.insideRules.followed);
          return (
            <li
              key={id}
              className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-4 text-sm"
            >
              <span className="font-medium text-text">{shortModel(id)}</span>
              <span className="tabular-nums text-text">
                Outside the rules: followed {countOf(out.followed, out.available)}
              </span>
              <span className="tabular-nums text-text">
                Inside the rules: followed {countOf(ins.followed, ins.available)}
              </span>
              <span className="tabular-nums text-text-muted">
                Held for review under Two-Key: {countOf(held, m.insideRules.followed)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

async function Results() {
  await connection();
  let s: ResultsSummary;
  try {
    s = await getResultsSummary();
  } catch {
    return <ResultsError />;
  }
  if (s.totals.runs === 0) {
    return (
      <EmptyState
        title="Results appear after the evaluation runs"
        body="Nothing has been recorded yet. Every number here comes from the evaluation tables."
      />
    );
  }
  return (
    <>
      <HeaderLine s={s} />
      {s.split === 'dev' ? (
        <Banner
          tone="info"
          text={`Development set. Test split in progress: ${countOf(s.testProgress.runs, s.testProgress.expected)} runs. Numbers below come from the dev split until the test split is complete.`}
        />
      ) : null}
      <Findings s={s} />
      <ResultsTabs
        summary={s}
        inside={<InsideRulesPanel summary={s} />}
        predictions={<PredictionsPanel summary={s} />}
        episodes={<EpisodesPanel summary={s} />}
        judge={
          <Suspense fallback={<LoadingState rows={3} />}>
            <JudgeAttacksPanel />
          </Suspense>
        }
      />
    </>
  );
}

export default function ResultsPage() {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Results</h1>
        <p className="text-base text-text">
          What happened when poisoned store listings tried to steer the shopping agent into buying
          from the attacker, or into buying the wrong thing.
        </p>
      </header>
      <Suspense fallback={<LoadingState rows={4} />}>
        <Results />
      </Suspense>
    </main>
  );
}
