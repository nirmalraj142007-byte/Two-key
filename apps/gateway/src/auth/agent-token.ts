import { createHash, randomBytes } from 'node:crypto';
import { AppError, ErrorCode } from '@twokey/core';
import { agentSessions, type Db } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import type { preHandlerAsyncHookHandler } from 'fastify';

export type AgentSession = typeof agentSessions.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    agentSession: AgentSession | null;
  }
}

export const AGENT_TOKEN_PREFIX = 'tk_agent_';

function hashToken(pepper: string, token: string): string {
  return createHash('sha256')
    .update(pepper + token, 'utf8')
    .digest('hex');
}

/** A new agent token and the hash stored in agent_sessions. Only the hash is ever persisted. */
export function mintAgentToken(pepper: string): { token: string; hash: string } {
  const token = AGENT_TOKEN_PREFIX + randomBytes(32).toString('base64url');
  return { token, hash: hashToken(pepper, token) };
}

/** Resolves `Authorization: Bearer tk_agent_…` to its active session, else UNAUTHENTICATED. */
export async function verifyAgentToken(
  db: Db,
  authorizationHeader: string | undefined,
  pepper: string,
): Promise<AgentSession> {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorizationHeader ?? '');
  const token = match?.[1];
  if (!token?.startsWith(AGENT_TOKEN_PREFIX)) {
    throw new AppError(ErrorCode.UNAUTHENTICATED, 'Agent token required');
  }
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.agentTokenHash, hashToken(pepper, token)),
        eq(agentSessions.status, 'active'),
      ),
    )
    .limit(1);
  if (!session) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Agent token is not valid');
  return session;
}

/** Fastify preHandler: attaches `request.agentSession` or rejects with 401. */
export function requireAgent(db: Db, pepper: string): preHandlerAsyncHookHandler {
  return async (req) => {
    req.agentSession = await verifyAgentToken(db, req.headers.authorization, pepper);
  };
}
