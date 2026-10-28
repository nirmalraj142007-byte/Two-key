import { readFileSync } from 'node:fs';
import { setTimeout as sleepMs } from 'node:timers/promises';
import {
  type HijackOutcome,
  type HijackProposal,
  REPLAY_REASON,
  type ReplayReason,
} from '@twokey/core';
import { makeRedactor, type Redactor, storePseudonyms } from '@twokey/core/redact';
import {
  agentSessions,
  type Db,
  evalEpisodes,
  evalRuns,
  gateDecisions,
  hijackAttempts,
  listings,
  merchants,
  proposals,
} from '@twokey/db';
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm';
import { failedOutcome } from './hijack.js';
import type { TranscriptEntry } from './run-session.js';
import type { RunStore } from './store.js';

/** Pause between replayed steps: the recorded gap, kept between these bounds. */
export const REPLAY_MIN_DELAY_MS = 400;
export const REPLAY_MAX_DELAY_MS = 2500;
const NOTIFY_TEXT_MAX = 2000;
const NOTIFY_BYTES_MAX = 7000;

export interface ReplayDeps {
  db: Db;
  store: Pick<RunStore, 'notify'>;
  /** Prefer this evaluation episode's followed run (the demo hook's). */
  demoEpisodeId?: string | undefined;
  redactor?: Redactor;
  sleep?: (ms: number) => Promise<unknown>;
  log?: { error: (o: object, m: string) => void };
}

/** The committed public term list (apps/web/data) plus the evaluation stores' pseudonyms. */
export async function loadRedactor(db: Db): Promise<Redactor> {
  const terms = JSON.parse(
    readFileSync(new URL('../../web/data/redaction-terms.json', import.meta.url), 'utf8'),
  ) as { brands: string[]; services: string[] };
  const stores = await db
    .select({ domain: merchants.displayName })
    .from(merchants)
    .where(eq(merchants.role, 'eval_merchant'))
    .orderBy(asc(merchants.id));
  return makeRedactor({ ...terms, stores: storePseudonyms(stores.map((s) => s.domain)) });
}

/** Every string inside a value, redacted (tool-call inputs are small JSON objects). */
function redactDeep(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v, redact)]),
    );
  }
  return value;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** The steps a replay shows: assistant and tool entries, redacted, without usage or IDs. */
export function replaySteps(transcript: unknown, redact: Redactor): TranscriptEntry[] {
  if (!Array.isArray(transcript)) return [];
  return (transcript as TranscriptEntry[])
    .filter((e) => e && (e.role === 'assistant' || e.role === 'tool'))
    .map((e) => ({
      turn: e.turn,
      role: e.role,
      text: redact(String(e.text ?? '')),
      ...(e.reasoning ? { reasoning: redact(e.reasoning) } : {}),
      ...(e.toolCalls?.length
        ? {
            toolCalls: e.toolCalls.map((c) => ({
              id: c.id,
              name: c.name,
              input: redactDeep(c.input, redact),
            })),
          }
        : {}),
      ...(e.toolName ? { toolName: e.toolName } : {}),
      ...(e.isError ? { isError: true } : {}),
      at: e.at,
    }));
}

/** Gap before step i, from the recorded timestamps. */
export function replayDelay(steps: readonly TranscriptEntry[], i: number): number {
  const prev = steps[i - 1];
  const cur = steps[i];
  if (!prev || !cur) return REPLAY_MIN_DELAY_MS;
  const gap = Date.parse(cur.at) - Date.parse(prev.at);
  if (!Number.isFinite(gap)) return REPLAY_MIN_DELAY_MS;
  return Math.min(REPLAY_MAX_DELAY_MS, Math.max(REPLAY_MIN_DELAY_MS, gap));
}

function stepNotice(userId: string, sessionId: string, entry: TranscriptEntry) {
  let shown: TranscriptEntry = {
    ...entry,
    text: clip(entry.text, NOTIFY_TEXT_MAX),
    ...(entry.reasoning ? { reasoning: clip(entry.reasoning, NOTIFY_TEXT_MAX) } : {}),
  };
  let payload = { type: 'hijack.step', userId, sessionId, entry: shown };
  if (JSON.stringify(payload).length > NOTIFY_BYTES_MAX) {
    const { toolCalls: _a, reasoning: _b, ...rest } = shown;
    shown = { ...rest, text: clip(entry.text, 500) };
    payload = { ...payload, entry: shown };
  }
  return payload;
}

interface RecordedRun {
  sessionId: string;
  model: string;
  startedAt: Date;
  targetListingId: string | null;
}

/** A recorded evaluation run whose agent followed the attack: the demo episode's first. */
async function pickRun(db: Db, demoEpisodeId: string | undefined): Promise<RecordedRun | null> {
  const base = () =>
    db
      .select({
        sessionId: evalRuns.sessionId,
        model: evalRuns.model,
        startedAt: evalRuns.startedAt,
        targetListingId: evalEpisodes.targetListingId,
      })
      .from(evalRuns)
      .innerJoin(evalEpisodes, eq(evalEpisodes.id, evalRuns.episodeId))
      .innerJoin(agentSessions, eq(agentSessions.id, evalRuns.sessionId));
  const followed = and(
    eq(evalRuns.followedAttack, true),
    isNotNull(evalRuns.sessionId),
    sql`jsonb_array_length(${agentSessions.transcript}) > 1`,
  );
  if (demoEpisodeId) {
    const [demo] = await base()
      .where(and(followed, eq(evalRuns.episodeId, demoEpisodeId)))
      .orderBy(sql`random()`)
      .limit(1);
    if (demo?.sessionId) return { ...demo, sessionId: demo.sessionId };
  }
  const [any] = await base().where(followed).orderBy(sql`random()`).limit(1);
  return any?.sessionId ? { ...any, sessionId: any.sessionId } : null;
}

/** The recorded run's gate outcomes under Two-Key (G4). No PayPal call was ever made. */
async function recordedProposals(
  db: Db,
  run: RecordedRun,
  transcript: unknown,
  redact: Redactor,
): Promise<HijackProposal[]> {
  const rows = await db
    .select({
      id: proposals.id,
      listingId: proposals.listingId,
      amountCents: proposals.resolvedAmountCents,
      title: listings.title,
      store: merchants.displayName,
      outcome: gateDecisions.outcome,
    })
    .from(proposals)
    .innerJoin(listings, eq(listings.id, proposals.listingId))
    .innerJoin(merchants, eq(merchants.id, proposals.resolvedMerchantId))
    .innerJoin(
      gateDecisions,
      and(eq(gateDecisions.proposalId, proposals.id), eq(gateDecisions.gate, 'G4')),
    )
    .where(eq(proposals.sessionId, run.sessionId))
    .orderBy(asc(proposals.createdAt));
  const entries = Array.isArray(transcript) ? (transcript as TranscriptEntry[]) : [];
  return rows.map((r) => {
    const tool = entries.find(
      (e) => e.role === 'tool' && e.text?.includes(`"proposalId":"${r.id}"`),
    );
    const sentence = tool ? tool.text.split('\n')[0] : undefined;
    const decision: HijackProposal['decision'] =
      r.outcome === 'block' ? 'blocked' : r.outcome === 'hold' ? 'held' : 'captured';
    const reason =
      decision === 'blocked'
        ? (sentence ?? 'Blocked by the rules. No PayPal order created.')
        : decision === 'held'
          ? 'Two-Key would hold it for approval: the price looks unusual.'
          : 'Inside the rules, so Two-Key would buy it. A recorded run makes no PayPal call.';
    return {
      product: redact(r.title),
      store: redact(r.store),
      amountCents: r.amountCents,
      decision,
      reason: redact(reason),
      attacker: r.listingId === run.targetListingId,
    };
  });
}

/**
 * Shows a recorded evaluation run in place of a live one: when today's caps are reached, the live
 * model is too slow, or the live run fails. Claims the attempt first (running → replayed), so a
 * live run that finishes later never overwrites it. Re-emits the recorded steps as
 * `hijack.step` events with realistic gaps, then the recorded gate outcome as `hijack.result`.
 * Returns null when the attempt was already finished or claimed.
 */
export async function replayAttempt(
  deps: ReplayDeps,
  attemptId: string,
  reason: ReplayReason,
): Promise<HijackOutcome | null> {
  const { db } = deps;
  const sleep = deps.sleep ?? sleepMs;
  const [claimed] = await db
    .update(hijackAttempts)
    .set({ status: 'replayed' })
    .where(and(eq(hijackAttempts.id, attemptId), eq(hijackAttempts.status, 'running')))
    .returning({
      sessionId: hijackAttempts.sessionId,
      mode: hijackAttempts.mode,
    });
  if (!claimed?.sessionId) return null;
  const sessionId = claimed.sessionId;
  const [session] = await db
    .select({ userId: agentSessions.userId })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  if (!session) return null;
  const { userId } = session;

  let outcome: HijackOutcome;
  let steps: TranscriptEntry[] = [];
  try {
    const run = await pickRun(db, deps.demoEpisodeId);
    if (!run) {
      outcome = failedOutcome('replay', 'No recorded run is available yet. Try again later.');
    } else {
      const [recorded] = await db
        .select({ transcript: agentSessions.transcript })
        .from(agentSessions)
        .where(eq(agentSessions.id, run.sessionId))
        .limit(1);
      const redact = deps.redactor ?? (await loadRedactor(db));
      steps = replaySteps(recorded?.transcript, redact);
      await deps.store.notify({
        type: 'hijack.replay',
        userId,
        sessionId,
        reason: REPLAY_REASON[reason],
      });
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i] as TranscriptEntry;
        await sleep(replayDelay(steps, i));
        await deps.store.notify(stepNotice(userId, sessionId, step));
      }
      outcome = {
        status: 'replayed',
        followed: true,
        proposals: await recordedProposals(db, run, recorded?.transcript, redact),
        attackerCents: 0,
        model: run.model,
        message: REPLAY_REASON[reason],
        recordedAt: run.startedAt.toISOString(),
      };
    }
  } catch (err) {
    deps.log?.error({ err, attemptId }, 'replay failed');
    outcome = failedOutcome('replay', 'This attempt could not be shown. Try again.');
  }

  await db
    .update(hijackAttempts)
    .set({
      status: outcome.status === 'failed' ? 'failed' : 'replayed',
      outcome: { ...outcome, steps },
    })
    .where(eq(hijackAttempts.id, attemptId));
  // A replay chosen at submit time has no live run to end the session.
  if (claimed.mode === 'replay') {
    await db
      .update(agentSessions)
      .set({ status: 'ended', endedAt: sql`now()` })
      .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.status, 'active')));
  }
  await deps.store.notify({ type: 'hijack.result', userId, sessionId, outcome });
  return outcome;
}
