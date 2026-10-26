'use server';

import { AppError, ErrorCode } from '@twokey/core';
import { agentSessions } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/auth';
import {
  FAILURE_TEXT,
  failureKind,
  type ProposalView,
  ProposalViewSchema,
} from '@/lib/console-view';
import { db } from '@/lib/db';
import { webEnv } from '@/lib/env';
import { gatewayFetch } from '@/lib/gateway';
import { mintAssertion } from '@/lib/human-assertion';
import { enqueueAgentRun } from '@/lib/jobs';

const Message = z.string().trim().min(1).max(2000);

export type StartRunResult = { ok: true; sessionId: string } | { ok: false; message: string };

/** Plain sentences for the failures a person can act on; everything else is generic. */
function sentence(err: unknown): string {
  if (err instanceof AppError) {
    if (err.code === ErrorCode.CONFLICT || err.code === ErrorCode.VALIDATION) {
      return err.message.endsWith('.') ? err.message : `${err.message}.`;
    }
    if (err.code === ErrorCode.UNAUTHENTICATED) return 'Sign in again.';
  }
  return 'The agent could not start. Try again.';
}

/**
 * Creates a demo session at the gateway, then queues the run for the agent runner. The model
 * defaults to the runner's live model (openai/gpt-oss-20b on NIM until Nov 7).
 */
export async function startRun(message: string, model?: string): Promise<StartRunResult> {
  const text = Message.safeParse(message);
  if (!text.success) return { ok: false, message: 'Type what you want the agent to buy.' };
  const session = await auth();
  if (!session?.userId) return { ok: false, message: 'Sign in again.' };
  const chosen = model ?? webEnv().AGENT_MODEL;
  try {
    const { sessionId, token } = await gatewayFetch<{ sessionId: string; token: string }>(
      '/human/sessions',
      { method: 'POST', scope: 'sessions:create', body: { mode: 'demo', model: chosen } },
    );
    await enqueueAgentRun({
      sessionId,
      userId: session.userId,
      token,
      userMessage: text.data,
      model: chosen,
      mode: 'demo',
    });
    return { ok: true, sessionId };
  } catch (err) {
    return { ok: false, message: sentence(err) };
  }
}

/** A fresh 60-second events:read assertion, minted before each (re)connect of the stream. */
export async function mintEventsAssertion(): Promise<string> {
  const session = await auth();
  if (!session?.userId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in again');
  return mintAssertion(session.userId, session.role, ['events:read']);
}

/** The last 10 proposals, so a reconnect catches up on anything the stream missed. */
export async function recentProposals(): Promise<ProposalView[]> {
  const res = await gatewayFetch<{ items: unknown[] }>('/human/proposals?limit=10', {
    scope: 'events:read',
  });
  return res.items.flatMap((i) => {
    const p = ProposalViewSchema.safeParse(i);
    return p.success ? [p.data] : [];
  });
}

export type RunStatus =
  | { status: 'active' }
  | { status: 'ended' }
  | { status: 'failed'; reason: string }
  | { status: 'unknown' };

/** Where a console run stands. Another user's session reads as unknown. */
export async function runStatus(sessionId: string): Promise<RunStatus> {
  const session = await auth();
  if (!session?.userId || !z.uuid().safeParse(sessionId).success) return { status: 'unknown' };
  const [row] = await db()
    .select({ status: agentSessions.status, transcript: agentSessions.transcript })
    .from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.userId, session.userId)))
    .limit(1);
  if (!row) return { status: 'unknown' };
  if (row.status === 'failed') {
    return { status: 'failed', reason: FAILURE_TEXT[failureKind(row.transcript)] };
  }
  return { status: row.status };
}
