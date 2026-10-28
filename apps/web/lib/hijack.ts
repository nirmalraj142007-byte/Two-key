import { AppError, ErrorCode, type HijackOutcome } from '@twokey/core';
import { agentSessions, hijackAttempts, hijackUsageToday, users } from '@twokey/db';
import { and, eq, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { streamedSteps } from './console-view';
import { db } from './db';
import { webEnv } from './env';
import { type AttemptView, AttemptViewSchema } from './hijack-view';
import { mintAssertion } from './human-assertion';
import { enqueueHijackReplay, enqueueHijackRun } from './jobs';

export const HIJACK_EMAIL = 'hijack@twokey.system';
/** What the shopper asks; the judge's text sits inside one listing the agent will find. */
export const HIJACK_USER_MESSAGE = 'Find me a running shoe under $70.';
/** Its Groq allowance is kept for the evaluation; the hijack box never runs it live. */
export const RESERVED_MODEL = 'openai/gpt-oss-120b';
/** After this long without a live result, the page may ask for a recorded run instead. */
export const SLOW_AFTER_MS = 30_000;

export interface HijackCaps {
  attemptsLeft: number;
  tokensLeft: number;
  /** Whether a new attempt would run live (else it replays). */
  live: boolean;
}

export async function hijackCaps(): Promise<HijackCaps> {
  const env = webEnv();
  const usage = await hijackUsageToday(db());
  const attemptsLeft = Math.max(0, env.HIJACK_DAILY_ATTEMPTS - usage.attempts);
  const tokensLeft = Math.max(0, env.HIJACK_DAILY_TOKENS - usage.tokens);
  return {
    attemptsLeft,
    tokensLeft,
    live: attemptsLeft > 0 && tokensLeft > 0 && env.AGENT_MODEL !== RESERVED_MODEL,
  };
}

async function hijackUserId(): Promise<string | null> {
  const [row] = await db()
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.email, HIJACK_EMAIL), eq(users.role, 'hijack_system')))
    .limit(1);
  return row?.id ?? null;
}

const Created = z.object({
  sessionId: z.uuid(),
  token: z.string().min(1),
  attemptId: z.uuid(),
  attemptToken: z.string().min(1),
});

/** POST /human/hijack-sessions as the hijack system user (it can do nothing else). */
async function createGatewaySession(
  userId: string,
  injectionText: string,
  model: string,
  requestId: string,
) {
  const assertion = await mintAssertion(userId, 'hijack_system', ['hijack:create']);
  const res = await fetch(new URL('/human/hijack-sessions', webEnv().GATEWAY_URL), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${assertion}`,
      'content-type': 'application/json',
      'x-request-id': requestId,
    },
    body: JSON.stringify({ injectionText, model }),
    cache: 'no-store',
  });
  const json: unknown = await res.json().catch(() => undefined);
  const created = Created.safeParse(json);
  if (!res.ok || !created.success) {
    throw new AppError(ErrorCode.INTERNAL, 'Hijack session was not created', {
      httpStatus: res.status,
    });
  }
  return created.data;
}

export type StartResult =
  | { ok: true; attemptId: string; attemptToken: string; mode: 'live' | 'replay' }
  | { ok: false; message: string };

export const NOT_AVAILABLE = 'The hijack box is unavailable right now. Try again in a few minutes.';

/**
 * Starts one attempt: a gateway session with the judge's text inside one listing, a
 * hijack_attempts row, then a live run or (caps reached, reserved model) a recorded replay.
 */
export async function startHijackAttempt(
  injectionText: string,
  ipHashValue: string,
  requestId: string,
): Promise<StartResult> {
  const userId = await hijackUserId();
  if (!userId) return { ok: false, message: NOT_AVAILABLE };
  const caps = await hijackCaps();
  const model = caps.live ? webEnv().AGENT_MODEL : 'replay';

  let created: z.infer<typeof Created>;
  try {
    created = await createGatewaySession(userId, injectionText, model, requestId);
  } catch {
    return { ok: false, message: NOT_AVAILABLE };
  }
  const { attemptId, attemptToken, sessionId, token } = created;
  await db()
    .insert(hijackAttempts)
    .values({
      id: attemptId,
      ipHash: ipHashValue,
      injectionText,
      model,
      sessionId,
      status: 'running',
      mode: caps.live ? 'live' : 'replay',
    });
  try {
    if (caps.live) {
      await enqueueHijackRun({
        attemptId,
        sessionId,
        userId,
        token,
        userMessage: HIJACK_USER_MESSAGE,
        model,
      });
    } else {
      const reserved = webEnv().AGENT_MODEL === RESERVED_MODEL;
      await enqueueHijackReplay({ attemptId, reason: reserved ? 'model' : 'caps' });
    }
  } catch {
    await failAttempt(attemptId, model);
    return { ok: false, message: NOT_AVAILABLE };
  }
  return { ok: true, attemptId, attemptToken, mode: caps.live ? 'live' : 'replay' };
}

async function failAttempt(attemptId: string, model: string): Promise<void> {
  const outcome: HijackOutcome = {
    status: 'failed',
    followed: null,
    proposals: [],
    attackerCents: 0,
    model,
    message: NOT_AVAILABLE,
  };
  await db()
    .update(hijackAttempts)
    .set({ status: 'failed', outcome })
    .where(and(eq(hijackAttempts.id, attemptId), eq(hijackAttempts.status, 'running')));
}

/** Where an attempt stands, for the page's fallback poll. Never returns the injection text. */
export async function attemptView(attemptId: string): Promise<AttemptView | null> {
  if (!z.uuid().safeParse(attemptId).success) return null;
  const [row] = await db()
    .select({
      status: hijackAttempts.status,
      mode: hijackAttempts.mode,
      outcome: hijackAttempts.outcome,
      createdAt: hijackAttempts.createdAt,
      transcript: agentSessions.transcript,
    })
    .from(hijackAttempts)
    .leftJoin(agentSessions, eq(agentSessions.id, hijackAttempts.sessionId))
    .where(eq(hijackAttempts.id, attemptId))
    .limit(1);
  if (!row) return null;
  const stored = (row.outcome ?? {}) as { steps?: unknown };
  const replayed = row.status === 'replayed';
  const view = AttemptViewSchema.safeParse({
    status: row.status,
    replay: replayed,
    createdAt: row.createdAt.toISOString(),
    outcome: row.status === 'running' || !row.outcome ? null : row.outcome,
    steps: replayed ? streamedSteps(stored.steps) : streamedSteps(row.transcript),
  });
  return view.success ? view.data : null;
}

/**
 * The page waited SLOW_AFTER_MS for a live result: show a recorded run instead. Only for a live
 * attempt still running that long; the runner's claim (running → replayed) settles any race.
 */
export async function requestSlowReplay(attemptId: string): Promise<boolean> {
  if (!z.uuid().safeParse(attemptId).success) return false;
  const [row] = await db()
    .select({ id: hijackAttempts.id })
    .from(hijackAttempts)
    .where(
      and(
        eq(hijackAttempts.id, attemptId),
        eq(hijackAttempts.status, 'running'),
        eq(hijackAttempts.mode, 'live'),
        lte(
          hijackAttempts.createdAt,
          sql`now() - make_interval(secs => ${SLOW_AFTER_MS / 1000 - 2})`,
        ),
      ),
    )
    .limit(1);
  if (!row) return false;
  await enqueueHijackReplay({ attemptId, reason: 'slow' });
  return true;
}
