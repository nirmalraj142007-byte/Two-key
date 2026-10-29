import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { countOf, pct } from '@/components/results/format';
import { SiteFooter } from '@/components/twokey/SiteFooter';
import { SiteHeader } from '@/components/twokey/SiteHeader';
import { attackNumbers } from '@/lib/public-numbers';
import { getResultsSummary } from '@/lib/results-queries';

export const metadata: Metadata = { title: 'About · Two-Key' };

const linkClass = 'text-accent underline underline-offset-4 hover:no-underline';
const INSIDE_HREF = '/results#inside-the-rules';

// Fixed text; the README reuses it verbatim.
const AP2 =
  "Google's Agent Payments Protocol (AP2) standardizes how a user's intent is expressed and signed as mandates, and PayPal is among its launch supporters. Two-Key works at a different layer: it enforces that intent at the moment money moves. PayPal capture runs only inside a gateway that verifies the user's signed rules, and the agent never holds a credential that can capture. AP2 describes the mandate; Two-Key enforces it at PayPal's capture step, today, in sandbox. Our rule card could serialize to an AP2 Intent Mandate.";

const SERVICES = [
  {
    name: 'web',
    holds: 'Sign-in, the key that signs your human approvals, and the rule compiler.',
    never: 'Never holds the PayPal secret or the rule-signing key.',
  },
  {
    name: 'gateway',
    holds:
      'The only PayPal caller: PayPal credentials, the rule-signing key, your saved wallet, holds and webhooks.',
    never: 'Never holds an LLM key.',
  },
  {
    name: 'twokey-mcp',
    holds: "The agent's four tools and one agent token per session.",
    never: 'Never holds a PayPal credential or a human token.',
  },
  {
    name: 'agent-runner',
    holds: 'The built-in shopping agent and its LLM keys.',
    never: 'Never holds a PayPal or signing credential.',
  },
] as const;

/** Item 1's numbers, from the results summary. */
async function InsideShare() {
  await connection();
  const s = await getResultsSummary().catch(() => null);
  if (!s || s.totals.runs === 0) {
    return (
      <>
        {' '}
        See{' '}
        <Link href={INSIDE_HREF} className={linkClass}>
          Inside the rules
        </Link>{' '}
        on Results.
      </>
    );
  }
  const a = attackNumbers(s);
  const followed = a.insideFollowed + a.outsideFollowed;
  const set = a.split === 'dev' ? ' (development set)' : '';
  return (
    <>
      {' '}
      {a.insideFollowed > a.outsideFollowed
        ? 'This is the most common successful attack in our data: '
        : 'In our data, '}
      {countOf(a.insideFollowed, followed)} followed attacks
      {followed > 0 ? ` (${pct(a.insideFollowed / followed)})` : ''} stayed inside the rules, and{' '}
      {a.insidePassed.toLocaleString('en-US')} passed every signed rule{set}. See{' '}
      <Link href={INSIDE_HREF} className={linkClass}>
        Inside the rules
      </Link>
      .
    </>
  );
}

async function Architecture() {
  const svg = await readFile(path.join(process.cwd(), '../../docs/architecture.svg'), 'utf8').catch(
    () => null,
  );
  if (svg) {
    return (
      // biome-ignore lint/performance/noImgElement: a local data-URI diagram needs no optimizer
      <img
        src={`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`}
        alt="Two-Key architecture: web, gateway, twokey-mcp and agent-runner, with the gateway as the only PayPal caller"
        className="w-full rounded-lg border border-border bg-surface-raised"
      />
    );
  }
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {SERVICES.map((s) => (
        <li
          key={s.name}
          className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-4"
        >
          <code className="font-mono text-sm font-medium text-text">{s.name}</code>
          <span className="text-sm text-text">{s.holds}</span>
          <span className="text-sm text-text-muted">{s.never}</span>
        </li>
      ))}
    </ul>
  );
}

export default function AboutPage() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-10 px-4 py-10">
        <header className="flex max-w-3xl flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-text">About Two-Key</h1>
          <p className="text-lg text-text">
            The agent can authorize the payment, but it can't capture it.
          </p>
        </header>

        <section aria-labelledby="ap2-title" className="flex max-w-3xl flex-col gap-2">
          <h2 id="ap2-title" className="text-xl font-medium text-text">
            Two-Key and AP2
          </h2>
          <p className="text-base text-text">{AP2}</p>
        </section>

        <section aria-labelledby="limits-title" className="flex max-w-3xl flex-col gap-3">
          <h2 id="limits-title" className="text-xl font-medium text-text">
            What Two-Key does not stop
          </h2>
          <ol className="flex list-decimal flex-col gap-3 pl-6 text-base text-text">
            <li>
              <span className="font-medium">A wrong product that fits every rule.</span> If an
              attack points the agent at another product at an allowed store, inside the budget, the
              signed rules let it through unless the price looks unusual.
              <Suspense fallback={null}>
                <InsideShare />
              </Suspense>
            </li>
            <li>
              <span className="font-medium">Sizes, colours and other details.</span> The agent must
              get these right. Every rules card shows them as “Agent's job — not checked by
              Two-Key”.
            </li>
            <li>
              <span className="font-medium">The hold window.</span> A held purchase reserves funds
              until you decide or it expires.
            </li>
          </ol>
        </section>

        <section aria-labelledby="arch-title" className="flex flex-col gap-3">
          <h2 id="arch-title" className="text-xl font-medium text-text">
            Architecture
          </h2>
          <p className="max-w-3xl text-base text-text">
            Four services. Only the gateway can move money.
          </p>
          <Suspense fallback={null}>
            <Architecture />
          </Suspense>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
