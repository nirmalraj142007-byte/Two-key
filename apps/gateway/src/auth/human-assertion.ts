import { AppError, ErrorCode } from '@twokey/core';
import type { preHandlerAsyncHookHandler } from 'fastify';
import { importSPKI, type JWTPayload, errors as joseErrors, jwtVerify } from 'jose';
import { LRUCache } from 'lru-cache';
import { z } from 'zod';
import { AGENT_TOKEN_PREFIX } from './agent-token.js';

export const SCOPES = [
  'vault:manage',
  'rules:sign',
  'sessions:create',
  'approvals:decide',
  'events:read',
  'push:manage',
  'hijack:create',
] as const;
export type Scope = (typeof SCOPES)[number];

export const ASSERTION_ISSUER = 'twokey-web';
export const ASSERTION_AUDIENCE = 'twokey-gateway';
const CLOCK_TOLERANCE_S = 5;
/** Longer than the 60 s lifetime plus clock tolerance, so a jti is remembered while it is valid. */
const JTI_TTL_MS = 120_000;

export interface Human {
  userId: string;
  role: 'user' | 'judge_demo' | 'hijack_system';
}

declare module 'fastify' {
  interface FastifyRequest {
    human: Human | null;
  }
}

const Claims = z.object({
  sub: z.uuid(),
  jti: z.string().min(1).max(100),
  role: z.enum(['user', 'judge_demo', 'hijack_system']),
  scope: z.string().max(500),
});

/** Why a check failed; logged instead of the token. */
export type RejectReason =
  | 'missing'
  | 'agent_token'
  | 'malformed'
  | 'expired'
  | 'bad_signature'
  | 'bad_claims'
  | 'replay'
  | 'scope';

export class AssertionRejected extends AppError {
  readonly reason: RejectReason;
  constructor(reason: RejectReason) {
    super(
      reason === 'scope' ? ErrorCode.FORBIDDEN : ErrorCode.UNAUTHENTICATED,
      reason === 'scope' ? 'Not allowed' : 'Sign in again',
    );
    this.reason = reason;
  }
}

export interface HumanAssertionVerifier {
  verifyHumanAssertion(header: string | undefined, requiredScope?: Scope): Promise<Human>;
}

/**
 * Verifies 60-second EdDSA assertions minted by web. Each jti is accepted once.
 *
 * The replay cache is in memory: the gateway runs as a single instance (one Render service,
 * no horizontal scaling). Running more than one instance would need a shared store instead.
 */
export function createHumanAssertionVerifier(
  publicKeyPem: string,
  opts: { now?: () => Date } = {},
): HumanAssertionVerifier {
  // Imported on first use: a bad key fails human requests (500), not the whole process.
  let key: ReturnType<typeof importSPKI> | undefined;
  const seen = new LRUCache<string, true>({ max: 100_000, ttl: JTI_TTL_MS });

  return {
    async verifyHumanAssertion(header, requiredScope) {
      if (!header) throw new AssertionRejected('missing');
      const match = /^Bearer (\S+)$/.exec(header);
      const token = match?.[1];
      if (!token) throw new AssertionRejected('malformed');
      // An agent token is never a human, whatever else it might look like.
      if (token.startsWith(AGENT_TOKEN_PREFIX)) throw new AssertionRejected('agent_token');

      key ??= importSPKI(publicKeyPem, 'EdDSA');
      const publicKey = await key;
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, publicKey, {
          algorithms: ['EdDSA'],
          issuer: ASSERTION_ISSUER,
          audience: ASSERTION_AUDIENCE,
          clockTolerance: CLOCK_TOLERANCE_S,
          requiredClaims: ['sub', 'jti', 'iat', 'exp'],
          ...(opts.now ? { currentDate: opts.now() } : {}),
        }));
      } catch (err) {
        if (err instanceof joseErrors.JWTExpired) throw new AssertionRejected('expired');
        if (err instanceof joseErrors.JWSSignatureVerificationFailed)
          throw new AssertionRejected('bad_signature');
        if (err instanceof joseErrors.JWTClaimValidationFailed)
          throw new AssertionRejected('bad_claims');
        throw new AssertionRejected('malformed');
      }

      const claims = Claims.safeParse(payload);
      if (!claims.success) throw new AssertionRejected('bad_claims');
      const { sub, jti, role, scope } = claims.data;
      // Lifetime is at most 60 s, however the token was minted.
      if ((payload.exp as number) - (payload.iat as number) > 60) {
        throw new AssertionRejected('bad_claims');
      }

      if (seen.has(jti)) throw new AssertionRejected('replay');
      seen.set(jti, true);

      if (requiredScope && !scope.split(' ').includes(requiredScope)) {
        throw new AssertionRejected('scope');
      }
      return { userId: sub, role };
    },
  };
}

/** Fastify preHandler factory: attaches `request.human` or rejects with 401/403. */
export function createRequireHuman(verifier: HumanAssertionVerifier) {
  return (scope?: Scope): preHandlerAsyncHookHandler =>
    async (req) => {
      try {
        req.human = await verifier.verifyHumanAssertion(req.headers.authorization, scope);
      } catch (err) {
        if (err instanceof AssertionRejected) {
          req.log.warn({ reason: err.reason, scope }, 'human assertion rejected');
        }
        throw err;
      }
    };
}
