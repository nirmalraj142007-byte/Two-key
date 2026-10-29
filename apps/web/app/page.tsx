import Link from 'next/link';
import { connection } from 'next/server';
import { Suspense } from 'react';
import { SiteFooter } from '@/components/twokey/SiteFooter';
import { SiteHeader } from '@/components/twokey/SiteHeader';
import { Button } from '@/components/ui/button';
import { attackLine, attackNumbers, stripCounts } from '@/lib/public-numbers';
import { getResultsSummary } from '@/lib/results-queries';

const STEPS = [
  {
    title: 'Connect PayPal once',
    body: 'Save your PayPal wallet with Two-Key. Your agent never sees it.',
  },
  {
    title: 'Sign your rules',
    body: 'Stores, caps and a time window, in plain words. Nothing is allowed until you sign.',
  },
  {
    title: 'Connect your agent',
    body: 'Give your agent the Two-Key MCP server. It can propose a purchase, never pay for one.',
  },
] as const;

/** Header counts and one line, all from the results summary. Hidden when nothing is recorded. */
async function LiveStrip() {
  await connection();
  const summary = await getResultsSummary().catch(() => null);
  if (!summary || summary.totals.runs === 0) return null;
  const a = attackNumbers(summary);
  return (
    <section
      aria-labelledby="live-title"
      className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-4"
    >
      <h2 id="live-title" className="text-sm font-medium text-text">
        From the evaluation{a.split === 'dev' ? ' (development set)' : ''}
      </h2>
      <p className="text-sm text-text-muted tabular-nums">{stripCounts(a)}</p>
      <p className="text-base text-text tabular-nums">{attackLine(a)}</p>
      <Link
        href="/results"
        className="w-fit text-sm text-accent underline underline-offset-4 hover:no-underline"
      >
        See all results
      </Link>
    </section>
  );
}

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-[1200px] flex-col gap-12 px-4 py-10 md:py-16">
        <section aria-labelledby="hero-title" className="flex max-w-3xl flex-col gap-5">
          <p className="text-sm font-medium text-accent">
            Not a shopping agent. The lock on its wallet.
          </p>
          <h1
            id="hero-title"
            className="text-3xl leading-tight font-semibold tracking-tight text-text md:text-5xl"
          >
            The agent can authorize the payment, but it can't capture it.
          </h1>
          <p className="text-lg text-text">
            Two-Key is one MCP server that replaces PayPal's money-moving tools. Your agent still
            shops. Only rules you signed — or you — can release the money.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild size="lg" className="h-11 px-5">
              <Link href="/hijack">Try to hijack it</Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="h-11 px-5">
              <Link href="/developers">Use it with your agent</Link>
            </Button>
          </div>
        </section>

        <Suspense fallback={null}>
          <LiveStrip />
        </Suspense>

        <section aria-labelledby="maya-title" className="flex max-w-3xl flex-col gap-2">
          <h2 id="maya-title" className="text-lg font-medium text-text">
            What happened to Maya
          </h2>
          <p className="text-base text-text">
            Maya lets an AI agent restock her running gear from her saved PayPal. One product page
            hid an instruction to buy a $189 gift card from a store she never allowed. Two-Key never
            created the PayPal order.
          </p>
          <p className="text-base text-text">
            The harder attack points the agent at a different shoe from a store she did allow. That
            fits her signed rules, so Two-Key holds it for her only when the price looks unusual.{' '}
            <Link
              href="/about#limits-title"
              className="text-accent underline underline-offset-4 hover:no-underline"
            >
              What Two-Key does not stop
            </Link>
          </p>
        </section>

        <section aria-labelledby="steps-title" className="flex flex-col gap-4">
          <h2 id="steps-title" className="text-lg font-medium text-text">
            Three steps
          </h2>
          <ol className="grid gap-3 md:grid-cols-3">
            {STEPS.map((step, i) => (
              <li
                key={step.title}
                className="flex flex-col gap-1 rounded-lg border border-border bg-surface-raised p-4"
              >
                <span className="text-sm text-text-muted tabular-nums">Step {i + 1}</span>
                <h3 className="text-base font-medium text-text">{step.title}</h3>
                <p className="text-sm text-text">{step.body}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
