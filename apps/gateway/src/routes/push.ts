import { AppError, ErrorCode } from '@twokey/core';
import { type Db, pushSubscriptions } from '@twokey/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createRequireHuman,
  type Human,
  type HumanAssertionVerifier,
} from '../auth/human-assertion.js';
import { isAllowedPushEndpoint } from '../services/push.js';

export interface PushRouteOptions {
  db: Db;
  verifier: HumanAssertionVerifier;
}

const Endpoint = z
  .string()
  .max(2048)
  .refine(isAllowedPushEndpoint, 'must be a browser push service URL');
const SubscribeBody = z.object({
  endpoint: Endpoint,
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});
const UnsubscribeBody = z.object({ endpoint: z.string().max(2048) });

function humanOf(req: FastifyRequest): Human {
  if (!req.human) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in again');
  return req.human;
}

export const pushRoutes: FastifyPluginAsync<PushRouteOptions> = async (app, opts) => {
  const { db } = opts;
  const requireHuman = createRequireHuman(opts.verifier);
  app.decorateRequest('human', null);

  app.post(
    '/human/push-subscriptions',
    { preHandler: requireHuman('push:manage') },
    async (req, reply) => {
      const { userId } = humanOf(req);
      const body = SubscribeBody.safeParse(req.body);
      if (!body.success) {
        throw new AppError(ErrorCode.VALIDATION, 'Body must be a browser push subscription');
      }
      const { endpoint, keys } = body.data;
      // One endpoint is one browser; whoever signed in on it last receives its pushes.
      await db
        .insert(pushSubscriptions)
        .values({ userId, endpoint, p256dh: keys.p256dh, auth: keys.auth })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: { userId, p256dh: keys.p256dh, auth: keys.auth },
        });
      return reply.status(201).send({ enabled: true });
    },
  );

  app.delete(
    '/human/push-subscriptions',
    { preHandler: requireHuman('push:manage') },
    async (req, reply) => {
      const { userId } = humanOf(req);
      const body = UnsubscribeBody.safeParse(req.body);
      if (!body.success) throw new AppError(ErrorCode.VALIDATION, 'Body must be { endpoint }');
      const deleted = await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.endpoint, body.data.endpoint),
            eq(pushSubscriptions.userId, userId),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      if (deleted.length === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Subscription not found');
      return reply.status(204).send();
    },
  );
};
