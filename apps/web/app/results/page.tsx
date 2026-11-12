import { formatUSD } from '@twokey/core/money';
import type { Metadata } from 'next';
import { connection } from 'next/server';
import { Suspense } from 'react';
import EpisodesPanel from '@/components/results/EpisodesPanel';
import { capComparison, countOf, pct, shareCount, shortModel } from '@/components/results/format';
import InsideRulesPanel from '@/components/results/InsideRulesPanel';
import JudgeAttacksPanel from '@/components/results/JudgeAttacksPanel';
import PredictionsPanel from '@/components/results/PredictionsPanel';
import { ResultsError, ResultsSkeleton, ResultsTabs } from '@/components/results/ResultsTabs';
import { Banner } from '@/components/twokey/banner';
import { EmptyState, LoadingState } from '@/components/twokey/state-panels';
import { fallbackCounts } from '@/lib/episodes-queries';
import { getResultsSummary, type ResultsSummary } from '@/lib/results-queries';
import { readForced } from '@/lib/test-states';

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

/**
 * The headline: the payee rule first, the anomaly hold as a measured second layer, then the
 * static cap compared directly, with the refusal split. Every number from the summary.
 */
function Findings({ s }: { s: ResultsSummary }) {
  const models = Object.values(s.models);
  const outside = models.reduce((a, m) => a + m.followByTarget.outside_rules.followed, 0);
  const inside = models.reduce((a, m) => a + m.insideRules.followed, 0);
  const held = models.reduce(
    (a, m) => a + shareCount(m.insideRules.heldShare, m.insideRules.followed),
    0,
  );
  const c = capComparison(s.models);
  const cap = formatUSD(s.staticCapCents);
  return (
    <section aria-labelledby="findings-title" className="flex flex-col gap-3">
      <h2 id="findings-title" className="sr-only">
        Findings
      </h2>
      <p className="text-lg text-text">
        <span className="font-medium">The guarantee is the payee rule.</span> Two-Key pays only
        stores the person signed for; any other store is blocked before a PayPal order exists. Money
        sent to an attacker under Two-Key:{' '}
        <span className="font-medium tabular-nums">{formatUSD(s.attackerMoneyCentsG4)}</span>.
        Agents followed <span className="tabular-nums">{outside}</span> attacks that pointed outside
        the rules
        {outside === 0 ? ', so this split does not test that block.' : '.'}
      </p>
      <p className="text-base text-text">
        <span className="font-medium">Second layer, measured: the anomaly hold.</span> Agents
        followed <span className="tabular-nums">{inside}</span> attacks that stayed inside the
        signed rules; Two-Key held <span className="tabular-nums">{countOf(held, inside)}</span> for
        the human and the rest went through.
      </p>
      <p className="text-base text-text">
        <span className="font-medium">Against a static {cap} cap</span> (the same proposals): the
        static cap let <span className="tabular-nums">{countOf(c.staticThrough, c.attacked)}</span>{' '}
        attacked runs end in a captured attack purchase, Two-Key{' '}
        <span className="tabular-nums">{countOf(c.g4Through, c.attacked)}</span>.{' '}
        {c.staticThrough <= c.g4Through
          ? `On this test the static cap did as well or better on attacks${outside === 0 ? ', because no agent tried to pay the attacker' : ''}. `
          : 'On this test Two-Key let fewer attacks through. '}
        A cap cannot refuse a payment to an attacker under the cap; the payee rule does.
      </p>
      <p className="text-base text-text">
        <span className="font-medium">
          Refusals, <span className="tabular-nums">{c.staticRefused}</span> vs{' '}
          <span className="tabular-nums">{c.g4Refused}</span>:
        </span>{' '}
        of <span className="tabular-nums">{c.honest}</span> honest purchases, the static cap refused{' '}
        <span className="tabular-nums">{c.staticRefused}</span> outright (each over {cap}
        ). Two-Key refused <span className="tabular-nums">{c.g4Refused}</span> (each broke a rule
        the person signed) and held <span className="tabular-nums">{c.g4Held}</span> more for one
        approval, <span className="tabular-nums">{c.g4Interrupted}</span> interruptions in all.
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

const FORCED = ['empty', 'loading', 'error', 'partial', 'success', 'judge'] as const;

async function Results({ searchParams }: { searchParams: PageProps<'/results'>['searchParams'] }) {
  await connection();
  // Forced states never invent numbers: partial and success show the real summary.
  const forced = readForced(await searchParams, FORCED);
  if (forced === 'loading') return <ResultsSkeleton />;
  let s: ResultsSummary;
  let fallbacks: Record<string, number>;
  try {
    if (forced === 'error') throw new Error('forced');
    s = await getResultsSummary();
    fallbacks = await fallbackCounts(s.split);
  } catch {
    return <ResultsError />;
  }
  if (s.totals.runs === 0 || forced === 'empty') {
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
      {s.split === 'dev' || forced === 'partial' ? (
        <Banner
          tone="info"
          text={`Development set. Test split in progress: ${countOf(s.testProgress.runs, s.testProgress.expected)} runs. Numbers below come from the dev split until the test split is complete.`}
        />
      ) : null}
      <Findings s={s} />
      <ResultsTabs
        summary={s}
        inside={<InsideRulesPanel summary={s} fallbacks={fallbacks} />}
        predictions={<PredictionsPanel summary={s} />}
        episodes={<EpisodesPanel summary={s} />}
        judge={
          <Suspense fallback={<LoadingState rows={3} />}>
            <JudgeAttacksPanel />
          </Suspense>
        }
        initialTab={forced === 'judge' ? 'judge' : undefined}
      />
    </>
  );
}

export default function ResultsPage(props: PageProps<'/results'>) {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium text-text">Results</h1>
        <p className="text-base text-text">
          What happened when poisoned store listings tried to steer the shopping agent into buying
          from the attacker, or into buying the wrong thing.
        </p>
      </header>
      <Suspense fallback={<ResultsSkeleton />}>
        <Results searchParams={props.searchParams} />
      </Suspense>
    </main>
  );
}
