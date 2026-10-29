import { ruleCards } from '@twokey/db';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { SiteFooter } from '@/components/twokey/SiteFooter';
import { SiteHeader } from '@/components/twokey/SiteHeader';
import { LoadingState } from '@/components/twokey/state-panels';
import { Button } from '@/components/ui/button';
import { isValidVapidKey } from '@/lib/approvals-view';
import { db } from '@/lib/db';
import { webEnv } from '@/lib/env';
import { gatewayFetch } from '@/lib/gateway';
import { requireUser } from '@/lib/session';
import { readForced } from '@/lib/test-states';
import { PushToggle } from '../approvals/push-toggle';
import { ActionButton } from './action-button';
import { disconnectPayPal, revokeRules, signOutAction } from './actions';

export const metadata: Metadata = { title: 'Settings · Two-Key' };

const linkClass = 'text-accent underline underline-offset-4 hover:no-underline';
const sectionClass = 'flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4';
const fmt = (d: Date) =>
  new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);

const FORCED = ['empty', 'loading', 'saving', 'error', 'partial', 'success'] as const;
type Forced = (typeof FORCED)[number];

/** `?__state=` screenshots only (lib/test-states.ts): what the Revoke button shows. */
function forcedButton(forced: Forced | null) {
  if (forced === 'saving') return 'saving' as const;
  if (forced === 'error') {
    return { status: 'error', message: 'Could not revoke your rules. Try again.' } as const;
  }
  if (forced === 'success') return { status: 'ok' } as const;
  return undefined;
}

async function Settings({
  searchParams,
}: {
  searchParams: PageProps<'/settings'>['searchParams'];
}) {
  const user = await requireUser();
  const forced = readForced(await searchParams, FORCED);
  if (forced === 'loading') return <LoadingState rows={3} />;
  const [realCards, me] = await Promise.all([
    db()
      .select({ id: ruleCards.id, version: ruleCards.version, expiresAt: ruleCards.expiresAt })
      .from(ruleCards)
      .where(
        and(
          eq(ruleCards.userId, user.userId),
          eq(ruleCards.status, 'signed'),
          gt(ruleCards.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(ruleCards.version)),
    gatewayFetch<{ vaultConnected: boolean }>('/human/me').catch(() => null),
  ]);
  const fixtureCard = {
    id: '01900000-0000-7000-8000-00000000d001',
    version: 1,
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  };
  const cards =
    forced === 'empty' ? [] : forced && realCards.length === 0 ? [fixtureCard] : realCards;
  const env = webEnv();
  const demo = user.role === 'judge_demo';

  return (
    <>
      <section aria-labelledby="rules-title" className={sectionClass}>
        <h2 id="rules-title" className="text-base font-medium text-text">
          Active rules
        </h2>
        {cards.length === 0 ? (
          <p className="text-sm text-text-muted">
            No signed rules. Your agent can't buy anything.{' '}
            <Link href="/rules/new" className={linkClass}>
              Build my rules
            </Link>
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {cards.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-text">
                  <Link href={`/rules/${c.id}`} className={linkClass}>
                    Rules, version {c.version}
                  </Link>{' '}
                  <span className="text-text-muted">
                    {c.expiresAt ? `· expires ${fmt(c.expiresAt)}` : null}
                  </span>
                </span>
                <ActionButton
                  action={revokeRules.bind(null, c.id)}
                  label="Revoke"
                  pendingLabel="Revoking…"
                  forced={forcedButton(forced)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="paypal-title" className={sectionClass}>
        <h2 id="paypal-title" className="text-base font-medium text-text">
          PayPal connection
        </h2>
        {me === null ? (
          <p className="text-sm text-text-muted">
            Could not check your PayPal connection. Reload to try again.
          </p>
        ) : demo ? (
          // Demo accounts keep their wallet: the button is always shown, always disabled.
          <div className="flex flex-col items-start gap-2">
            {me.vaultConnected ? (
              <p className="text-sm text-text">Connected to your saved PayPal wallet.</p>
            ) : (
              <p className="text-sm text-text-muted">
                Not connected.{' '}
                <Link href="/onboarding/paypal" className={linkClass}>
                  Connect PayPal
                </Link>
              </p>
            )}
            <Button
              variant="outline"
              className="h-11 px-4"
              disabled
              aria-describedby="disconnect-note"
            >
              Disconnect
            </Button>
            <p id="disconnect-note" className="text-sm text-text-muted">
              Demo accounts can't disconnect PayPal
            </p>
          </div>
        ) : !me.vaultConnected ? (
          <p className="text-sm text-text-muted">
            Not connected.{' '}
            <Link href="/onboarding/paypal" className={linkClass}>
              Connect PayPal
            </Link>
          </p>
        ) : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-text">Connected to your saved PayPal wallet.</p>
            <ActionButton
              action={disconnectPayPal}
              label="Disconnect"
              pendingLabel="Disconnecting…"
            />
          </div>
        )}
      </section>

      <PushToggle
        vapidPublicKey={
          isValidVapidKey(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
            ? env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
            : null
        }
        forcedStatus={forced === 'partial' ? 'denied' : undefined}
      />

      <form action={signOutAction}>
        <Button type="submit" variant="outline" className="h-11 px-4">
          Sign out
        </Button>
      </form>
    </>
  );
}

export default function SettingsPage(props: PageProps<'/settings'>) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-10">
        <header className="flex flex-col gap-1">
          <h1 className="text-3xl font-semibold tracking-tight text-text">Settings</h1>
          <p className="text-base text-text-muted">Your rules, your PayPal wallet and alerts.</p>
        </header>
        <Suspense fallback={<LoadingState rows={3} />}>
          <Settings searchParams={props.searchParams} />
        </Suspense>
      </main>
      <SiteFooter />
    </>
  );
}
