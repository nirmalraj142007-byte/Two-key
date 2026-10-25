import { createHash, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode, RuleCardSchema, signCard } from '@twokey/core';
import { agentSessions, type Db, evalEpisodes, evalTasks, ruleCards, users } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, preHandlerAsyncHookHandler } from 'fastify';
import { z } from 'zod';
import { mintAgentToken } from '../auth/agent-token.js';
import type { RuleKeys } from '../services/keys.js';

export const EVAL_USER_EMAIL = 'eval@twokey.system';

export interface InternalEvalOptions {
  db: Db;
  adminToken: string;
  keys: RuleKeys;
  signingKeyId: string;
  agentTokenPepper: string;
  now?: () => Date;
}

const Body = z.object({ episodeId: z.uuid(), model: z.string().min(1).max(100) });
const GoalAttrs = z.object({
  sampleIndex: z.number().int().min(0),
  evalCard: z.record(z.string(), z.unknown()),
});

/** Compares digests so the check takes the same time whatever the header holds. */
function sameToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function requireEvalToken(expected: string): preHandlerAsyncHookHandler {
  return async (req) => {
    const header = req.headers['x-eval-token'];
    if (typeof header !== 'string' || !sameToken(header, expected)) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Evaluation token required');
    }
  };
}

/**
 * Evaluation-only session minting. Mounted only when EVAL_ENABLED=true outside production
 * (see app.ts); the eval CLI calls it once per (episode, model) run.
 */
export const internalEvalRoutes: FastifyPluginAsync<InternalEvalOptions> = async (app, opts) => {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const secret = opts.keys[opts.signingKeyId];
  if (!secret) throw new AppError(ErrorCode.CONFIG_INVALID, 'Signing key is not loaded');

  async function evalUserId(): Promise<string> {
    await db
      .insert(users)
      .values({ email: EVAL_USER_EMAIL, displayName: 'Evaluation', role: 'hijack_system' })
      .onConflictDoNothing({ target: users.email });
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, EVAL_USER_EMAIL));
    if (!row) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
    return row.id;
  }

  /** One signed card per task (version = sample index + 1), created on first use and reused. */
  async function taskCardId(userId: string, taskId: string, rawAttrs: unknown): Promise<string> {
    const attrs = GoalAttrs.safeParse(rawAttrs);
    if (!attrs.success) {
      throw new AppError(ErrorCode.RULE_CARD_INVALID, `Task ${taskId} has no eval card`);
    }
    const version = attrs.data.sampleIndex + 1;
    const nlRequest = `eval task ${taskId}`;
    const find = async () => {
      const [row] = await db
        .select({ id: ruleCards.id, nlRequest: ruleCards.nlRequest, status: ruleCards.status })
        .from(ruleCards)
        .where(and(eq(ruleCards.userId, userId), eq(ruleCards.version, version)))
        .limit(1);
      return row;
    };

    let row = await find();
    if (!row) {
      const parsed = RuleCardSchema.safeParse({ ...attrs.data.evalCard, userId, version });
      if (!parsed.success) {
        throw new AppError(ErrorCode.RULE_CARD_INVALID, `Eval card for task ${taskId} is invalid`);
      }
      const signed = signCard(parsed.data, { id: opts.signingKeyId, secret: secret as Buffer });
      // Two runs of the same task may race here; the loser reads the winner's row.
      await db
        .insert(ruleCards)
        .values({
          userId,
          version,
          status: 'signed',
          nlRequest,
          rules: signed.card,
          enforcement: {},
          signedAt: now(),
          expiresAt: new Date(parsed.data.expiresAt),
          hmac: signed.sig,
          keyId: signed.keyId,
        })
        .onConflictDoNothing({ target: [ruleCards.userId, ruleCards.version] });
      row = await find();
    }
    if (!row || row.nlRequest !== nlRequest || row.status !== 'signed') {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Eval card version ${version} belongs to another task`,
      );
    }
    return row.id;
  }

  app.post(
    '/internal/eval/sessions',
    { preHandler: requireEvalToken(opts.adminToken) },
    async (req) => {
      const body = Body.safeParse(req.body);
      if (!body.success) {
        throw new AppError(ErrorCode.VALIDATION, 'Body must be { episodeId, model }');
      }
      const { episodeId, model } = body.data;
      const [episode] = await db
        .select({ taskId: evalTasks.id, goalAttrs: evalTasks.goalAttrs })
        .from(evalEpisodes)
        .innerJoin(evalTasks, eq(evalTasks.id, evalEpisodes.taskId))
        .where(eq(evalEpisodes.id, episodeId))
        .limit(1);
      if (!episode) throw new AppError(ErrorCode.NOT_FOUND, 'Unknown episode');

      const userId = await evalUserId();
      const ruleCardId = await taskCardId(userId, episode.taskId, episode.goalAttrs);
      const { token, hash } = mintAgentToken(opts.agentTokenPepper);
      const [session] = await db
        .insert(agentSessions)
        .values({
          userId,
          ruleCardId,
          mode: 'eval',
          model,
          agentTokenHash: hash,
          evalEpisodeId: episodeId,
        })
        .returning({ id: agentSessions.id });
      if (!session) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
      return { sessionId: session.id, token };
    },
  );
};
