/**
 * npm run demo:reset [-- --env local|prod]  — puts the demo tenant back to a clean state. Daily
 * at 09:00 IST it runs in GitHub Actions (.github/workflows/demo-reset.yml; plan A: the Render
 * twokey-demo-reset cron job) with the secrets in the environment and no --env.
 *
 * For maya and judge1–3 only (by email, never by role):
 * 1. Voids every held authorization through the gateway's own void path (voidHeld: row lock,
 *    state check, the payee merchant's credentials, request ID tk-{proposalId}-void). A payment
 *    still open at PayPal is never deleted.
 * 2. Deletes their proposals with no payment or a finished one, with those payments' events,
 *    approvals and gate decisions, then their ended or failed sessions left empty. Only rows
 *    created before this run and untouched for 5 minutes: someone using the site keeps their run.
 * 3. Re-signs any demo card (and the hijack user's) that is missing or expires within 7 days.
 * 4. Rebuilds the demo hook listing (demo:hook --pinned).
 * Prints counts. Safe to run twice. Never touches eval tables, eval or hijack sessions, or
 * hijack_attempts (the published dataset), and never deletes anything at PayPal.
 */
import { AppError, createLogger, ErrorCode } from '@twokey/core';
import { createDb, payments, users } from '@twokey/db';
import { createJobRunner, voidHeld } from '@twokey/gateway';
import { createMerchantPayPal } from '@twokey/paypal';
import { and, eq, inArray, sql as raw } from 'drizzle-orm';
import { z } from 'zod';
import { buildDemoHook, hookSummary } from './demo-hook-lib.js';
import {
  activeCard,
  cardVerifies,
  DEMO_ACCOUNTS,
  DEMO_EMAILS,
  day,
  demoUsers,
  HIJACK_EMAIL,
  loadDemoEnv,
  RESIGN_WITHIN_MS,
  requireVars,
  ruleKey,
  signDemoCard,
  signHijackCard,
} from './demo-lib.js';

const SCRIPT = 'demo:reset';
/** Rows touched more recently than this belong to someone using the site right now. */
const QUIET_MS = 5 * 60 * 1000;
const FINISHED = ['captured', 'voided', 'expired', 'denied', 'failed'] as const;

const envName = loadDemoEnv(process.argv.slice(2), SCRIPT);
const env = requireVars(SCRIPT, [
  'DATABASE_URL',
  'RULE_HMAC_KEY',
  'RULE_HMAC_KEY_ID',
  'PAYPAL_ENV',
  'MERCHANT_API_CREDENTIALS',
]);
const credentials = z
  .record(
    z.string().min(1),
    z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }),
  )
  .safeParse(JSON.parse(env.MERCHANT_API_CREDENTIALS));
if (!credentials.success || (env.PAYPAL_ENV !== 'sandbox' && env.PAYPAL_ENV !== 'live')) {
  console.error('MERCHANT_API_CREDENTIALS or PAYPAL_ENV is invalid');
  process.exit(1);
}

const log = createLogger('gateway', process.env.LOG_LEVEL === 'debug' ? 'debug' : 'warn');
const { db, sql } = createDb(env.DATABASE_URL);
const jobs = createJobRunner(env.DATABASE_URL, log);
const runStart = new Date();
const quietBefore = new Date(runStart.getTime() - QUIET_MS);
const key = ruleKey();

const counts = {
  voided: 0,
  voidsLeftOpen: 0,
  holdsSkippedRecent: 0,
  paymentEvents: 0,
  approvals: 0,
  payments: 0,
  gateDecisions: 0,
  proposals: 0,
  sessions: 0,
  openPaymentsKept: 0,
  cardsSigned: 0,
};

try {
  console.log(`demo:reset --env ${envName} at ${runStart.toISOString()}`);
  const people = await demoUsers(db);
  const ids = people.map((u) => u.id);
  if (ids.length === 0) throw new AppError(ErrorCode.NOT_FOUND, 'No demo users: run demo:setup');

  // 1. holds -> void through the gateway's own path.
  const held = await sql<{ id: string; recent: boolean }[]>`
    select p.id, p.updated_at >= ${quietBefore.toISOString()}::timestamptz as recent
    from payments p join proposals pr on pr.id = p.proposal_id
    join agent_sessions s on s.id = pr.session_id
    where p.state = 'held' and s.user_id in ${sql(ids)} and s.mode in ('live', 'demo')`;
  const deps = {
    db,
    jobs,
    log,
    merchantPayPal: createMerchantPayPal(credentials.data, { env: env.PAYPAL_ENV, logger: log }),
    // A reset never captures.
    paypal: {
      capture: async (): Promise<never> => {
        throw new AppError(ErrorCode.INTERNAL, 'demo:reset never captures');
      },
    },
  };
  for (const h of held) {
    if (h.recent) {
      counts.holdsSkippedRecent += 1;
      continue;
    }
    try {
      const { state } = await voidHeld(deps, h.id, 'timer', 'demo_reset');
      if (state === 'voided') counts.voided += 1;
      else counts.voidsLeftOpen += 1; // void_requested: the gateway's reconciler settles it
    } catch (err) {
      // Decided meanwhile (CONFLICT) is fine; anything else leaves the hold untouched.
      if (!(err instanceof AppError && err.code === ErrorCode.CONFLICT)) {
        counts.voidsLeftOpen += 1;
        console.error(
          `hold ${h.id.slice(0, 8)}… not voided: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  // 2. delete finished history, in one transaction.
  await db.transaction(async (tx) => {
    const candidates = await tx.execute<{ id: string; payment_id: string | null }>(raw`
      select pr.id, p.id as payment_id
      from proposals pr
      join agent_sessions s on s.id = pr.session_id
      left join payments p on p.proposal_id = pr.id
      where s.user_id in (${raw.join(
        ids.map((i) => raw`${i}`),
        raw`, `,
      )})
        and s.mode in ('live', 'demo')
        and s.created_at < ${runStart.toISOString()}::timestamptz
        and pr.created_at < ${quietBefore.toISOString()}::timestamptz
        and (p.id is null or (p.state in (${raw.join(
          FINISHED.map((f) => raw`${f}`),
          raw`, `,
        )})
             and p.updated_at < ${quietBefore.toISOString()}::timestamptz))
      for update of pr skip locked`);
    const proposalIds = candidates.map((c) => c.id);
    const paymentIds = candidates.flatMap((c) => (c.payment_id ? [c.payment_id] : []));
    if (paymentIds.length > 0) {
      counts.paymentEvents = (
        await tx.execute(
          raw`delete from payment_events where payment_id in (${raw.join(
            paymentIds.map((i) => raw`${i}`),
            raw`, `,
          )}) returning id`,
        )
      ).length;
      counts.approvals = (
        await tx.execute(
          raw`delete from approvals where payment_id in (${raw.join(
            paymentIds.map((i) => raw`${i}`),
            raw`, `,
          )}) returning id`,
        )
      ).length;
      counts.payments = (
        await tx
          .delete(payments)
          .where(and(inArray(payments.id, paymentIds), inArray(payments.state, [...FINISHED])))
          .returning({ id: payments.id })
      ).length;
    }
    if (proposalIds.length > 0) {
      const list = raw.join(
        proposalIds.map((i) => raw`${i}`),
        raw`, `,
      );
      counts.gateDecisions = (
        await tx.execute(
          raw`delete from gate_decisions where proposal_id in (${list}) returning id`,
        )
      ).length;
      counts.proposals = (
        await tx.execute(raw`delete from proposals where id in (${list}) returning id`)
      ).length;
    }
    counts.sessions = (
      await tx.execute(raw`
        delete from agent_sessions s
        where s.user_id in (${raw.join(
          ids.map((i) => raw`${i}`),
          raw`, `,
        )})
          and s.mode in ('live', 'demo') and s.status in ('ended', 'failed')
          and s.created_at < ${runStart.toISOString()}::timestamptz
          and coalesce(s.ended_at, s.created_at) < ${quietBefore.toISOString()}::timestamptz
          and not exists (select 1 from proposals p where p.session_id = s.id)
          and not exists (select 1 from hijack_attempts h where h.session_id = s.id)
          and not exists (select 1 from catalog_snapshots c where c.session_id = s.id)
          and not exists (select 1 from eval_runs r where r.session_id = s.id)
        returning s.id`)
    ).length;
  });
  const [open] = await sql<{ n: number }[]>`
    select count(*)::int as n from payments p join proposals pr on pr.id = p.proposal_id
    join agent_sessions s on s.id = pr.session_id
    where s.user_id in ${sql(ids)} and p.state not in ${sql([...FINISHED])}`;
  counts.openPaymentsKept = open?.n ?? 0;

  // 3. cards
  const now = new Date();
  const fresh = async (userId: string) => {
    const card = await activeCard(db, userId, now);
    return (
      card?.expiresAt != null &&
      card.expiresAt.getTime() - now.getTime() > RESIGN_WITHIN_MS &&
      (await cardVerifies(db, userId, key, now))
    );
  };
  for (const a of DEMO_ACCOUNTS) {
    const u = people.find((p) => p.email === a.email);
    if (!u || (await fresh(u.id))) continue;
    const s = await signDemoCard(db, u.id, key, now);
    counts.cardsSigned += 1;
    console.log(`rules   ${a.email} signed v${s.version}, expires ${day(s.expiresAt)}`);
  }
  const [hijack] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, HIJACK_EMAIL));
  if (hijack && !(await fresh(hijack.id))) {
    const s = await signHijackCard(db, hijack.id, key, now);
    counts.cardsSigned += 1;
    console.log(`rules   ${HIJACK_EMAIL} signed v${s.version}, expires ${day(s.expiresAt)}`);
  }

  // 4. demo hook
  console.log(hookSummary(await buildDemoHook(sql, { pinned: true })));

  console.log(`accounts: ${people.map((p) => p.email).join(', ')} (of ${DEMO_EMAILS.length})`);
  for (const [k, v] of Object.entries(counts)) console.log(`${k.padEnd(20)} ${v}`);
  if (counts.voidsLeftOpen > 0) process.exitCode = 1;
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await jobs.stop();
  await sql.end();
}
