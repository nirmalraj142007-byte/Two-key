import { XIcon } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { EpisodesTable } from '@/components/results/EpisodesTable';
import { gateLabel, shortModel } from '@/components/results/format';
import { ResultsError } from '@/components/results/ResultsTabs';
import { Banner } from '@/components/twokey/banner';
import { EmptyState, LoadingState } from '@/components/twokey/state-panels';
import { type EpisodesPage, listEpisodes } from '@/lib/episodes-queries';
import { type EpisodeFilters, FILTER_KEYS, parseEpisodeFilters } from '@/lib/episodes-view';
import { getResultsSummary } from '@/lib/results-queries';
import { FORCED_STATE_PARAM, readForced } from '@/lib/test-states';

export const metadata: Metadata = { title: 'Episodes · Results · Two-Key' };

const SET_LABEL = {
  followed: 'Followed attacks',
  attacked: 'Attacked runs',
  clean: 'Clean runs',
  interrupted: 'Honest purchases interrupted',
  let_through: 'Attacks let through',
} as const;
const VARIANT_LABEL = { clean: 'Clean', injecagent: 'InjecAgent', agentdojo: 'AgentDojo' };
const TARGET_LABEL = { outside_rules: 'Outside the rules', inside_rules: 'Inside the rules' };
const OUTCOME_LABEL = {
  capture: 'Captured',
  hold: 'Held',
  block: 'Blocked',
  ask_every_time: 'Asked',
  passed: 'Passed every rule',
};

type Params = Record<string, string | string[] | undefined>;

function chipLabel(key: keyof EpisodeFilters, f: EpisodeFilters, staticCapCents: number) {
  switch (key) {
    case 'split':
      return f.split === 'test' ? 'Test split' : 'Dev split';
    case 'model':
      return `Model: ${shortModel(f.model ?? '')}`;
    case 'gate':
      return f.gate ? `Gate: ${f.gate} ${gateLabel(f.gate, staticCapCents)}` : '';
    case 'set':
      return f.set ? SET_LABEL[f.set] : '';
    case 'variant':
      return f.variant ? `Variant: ${VARIANT_LABEL[f.variant]}` : '';
    case 'target':
      return f.target ? TARGET_LABEL[f.target] : '';
    case 'outcome':
      return f.outcome ? `${f.gate ?? 'G4'}: ${OUTCOME_LABEL[f.outcome]}` : '';
    case 'page':
      return '';
  }
}

function hrefWith(f: EpisodeFilters, change: Partial<Record<keyof EpisodeFilters, string | null>>) {
  const q = new URLSearchParams();
  for (const key of FILTER_KEYS) {
    const v = key in change ? change[key] : f[key];
    if (v !== undefined && v !== null && v !== '') q.set(key, String(v));
  }
  const s = q.toString();
  return s ? `/results/episodes?${s}` : '/results/episodes';
}

/** Filters from the URL, each removable. */
function FilterChips({ f, staticCapCents }: { f: EpisodeFilters; staticCapCents: number }) {
  const keys = FILTER_KEYS.filter((k) => k !== 'page' && f[k] !== undefined);
  if (keys.length === 0) return <p className="text-sm text-text-muted">No filters: every run.</p>;
  return (
    <ul className="flex flex-wrap items-center gap-2" aria-label="Filters">
      {keys.map((k) => {
        const label = chipLabel(k, f, staticCapCents);
        return (
          <li key={k}>
            <Link
              href={hrefWith(f, { [k]: null, page: null })}
              aria-label={`Remove filter ${label}`}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-sm text-text hover:bg-surface-raised focus-visible:outline-2 focus-visible:outline-focus"
            >
              {label}
              <XIcon aria-hidden="true" className="size-3.5 text-text-muted" />
            </Link>
          </li>
        );
      })}
      {keys.length > 1 ? (
        <li>
          <Link
            href="/results/episodes"
            className="text-sm text-accent underline-offset-4 hover:underline"
          >
            Clear all
          </Link>
        </li>
      ) : null}
    </ul>
  );
}

function Pager({ p }: { p: EpisodesPage }) {
  if (p.pages <= 1) return null;
  const link = (page: number, text: string) => (
    <Link
      href={hrefWith(p.filters, { page: String(page) })}
      className="text-accent underline-offset-4 hover:underline"
    >
      {text}
    </Link>
  );
  return (
    <nav aria-label="Pages" className="flex items-center gap-4 text-sm tabular-nums">
      {p.page > 1 ? link(p.page - 1, 'Previous 200') : null}
      <span className="text-text-muted">
        Page {p.page} of {p.pages}
      </span>
      {p.page < p.pages ? link(p.page + 1, 'Following 200') : null}
    </nav>
  );
}

const FORCED = ['empty', 'loading', 'error', 'success'] as const;

async function Episodes({ searchParams }: { searchParams: Promise<Params> }) {
  await connection();
  const params = await searchParams;
  const forced = readForced(params, FORCED);
  if (forced === 'loading') return <LoadingState rows={6} />;
  if (forced === 'empty') {
    return (
      <EmptyState
        title="No runs match these filters"
        body="Remove a filter above to see more runs."
      />
    );
  }
  const { filters, invalid } = parseEpisodeFilters(params);
  let page: EpisodesPage;
  let staticCapCents: number;
  try {
    if (forced === 'error') throw new Error('forced');
    [page, { staticCapCents }] = await Promise.all([listEpisodes(filters), getResultsSummary()]);
  } catch {
    return <ResultsError />;
  }
  const first = (page.page - 1) * page.pageSize + 1;
  return (
    <>
      {invalid.filter((v) => !v.startsWith(FORCED_STATE_PARAM)).length > 0 ? (
        <Banner tone="info" text={`Ignored an unknown filter value: ${invalid.join(', ')}.`} />
      ) : null}
      {page.split === 'dev' && !filters.split ? (
        <Banner
          tone="info"
          text="Development set: the same split the summary shows until the test split is complete."
        />
      ) : null}
      <div className="flex flex-col gap-3">
        <FilterChips f={filters} staticCapCents={staticCapCents} />
        <p className="text-base text-text tabular-nums" data-testid="episodes-count">
          <span className="font-medium">{page.total.toLocaleString('en-US')}</span>{' '}
          {page.total === 1 ? 'run' : 'runs'}
          {page.pages > 1 ? (
            <span className="text-text-muted">
              {' '}
              · showing {first}–{first + page.rows.length - 1}
            </span>
          ) : null}
        </p>
      </div>
      {page.total === 0 ? (
        <EmptyState
          title="No runs match these filters"
          body="Remove a filter above to see more runs."
        />
      ) : (
        <>
          <EpisodesTable rows={page.rows} />
          <Pager p={page} />
        </>
      )}
    </>
  );
}

export default function EpisodesPageView({ searchParams }: PageProps<'/results/episodes'>) {
  return (
    <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-6 px-4 py-8">
      <header className="flex flex-col gap-1">
        <nav aria-label="Breadcrumb" className="text-sm text-text-muted">
          <Link href="/results" className="text-accent underline-offset-4 hover:underline">
            Results
          </Link>{' '}
          / Episodes
        </nav>
        <h1 className="text-2xl font-medium text-text">Episodes</h1>
        <p className="text-base text-text">
          Every evaluation run, one row per task and model. Open a row to see the whole trip: the
          listings the agent saw, the text inserted into one of them, what the agent did, and what
          each gate decided.
        </p>
      </header>
      <Suspense fallback={<LoadingState rows={6} />}>
        <Episodes searchParams={searchParams} />
      </Suspense>
    </main>
  );
}
