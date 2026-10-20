import { createHmac, timingSafeEqual } from 'node:crypto';
import canonicalizeModule from 'canonicalize';
import { z } from 'zod';
import { AppError, ErrorCode } from '../errors.js';
import { type RuleCard, RuleCardSchema } from './schema.js';

// canonicalize is CommonJS (`module.exports = fn`) but its .d.ts declares `export default`,
// which NodeNext types as the module object. At runtime the default import is the function.
const canonicalize = canonicalizeModule as unknown as (input: unknown) => string | undefined;

export type SignedCard = { card: RuleCard; keyId: string; alg: 'HS256'; sig: string };

const SignedEnvelope = z.object({
  card: z.unknown(),
  keyId: z.string().min(1),
  alg: z.literal('HS256'),
  sig: z.string().min(1),
});

type InvalidReason = 'unknown_key' | 'bad_signature' | 'schema' | 'expired';

function invalid(reason: InvalidReason, message: string): AppError {
  return new AppError(ErrorCode.RULE_CARD_INVALID, message, { details: { reason } });
}

/** RFC 8785 canonical JSON, so the signature does not depend on key order. */
function canonical(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) throw invalid('schema', 'Rule card is not serializable');
  return out;
}

function hmac(secret: Buffer, value: unknown): Buffer {
  return createHmac('sha256', secret).update(canonical(value), 'utf8').digest();
}

export function signCard(card: RuleCard, key: { id: string; secret: Buffer }): SignedCard {
  return {
    card,
    keyId: key.id,
    alg: 'HS256',
    sig: hmac(key.secret, card).toString('base64url'),
  };
}

/**
 * Checks, in order: envelope shape, key ID, signature (over the card exactly as received),
 * card schema, expiry. Any failure throws RULE_CARD_INVALID with `details.reason`.
 */
export function verifyCard(signed: unknown, keys: Record<string, Buffer>, now: Date): RuleCard {
  const envelope = SignedEnvelope.safeParse(signed);
  if (!envelope.success) throw invalid('schema', 'Signed rule card is malformed');
  const { card, keyId, sig } = envelope.data;

  const secret = Object.hasOwn(keys, keyId) ? keys[keyId] : undefined;
  if (secret === undefined)
    throw invalid('unknown_key', 'Rule card was signed with an unknown key');

  const expected = hmac(secret, card);
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw invalid('bad_signature', 'Rule card signature does not match');
  }

  const parsed = RuleCardSchema.safeParse(card);
  if (!parsed.success) throw invalid('schema', 'Rule card does not match the schema');

  if (now.getTime() >= Date.parse(parsed.data.expiresAt)) {
    throw invalid('expired', 'Rule card has expired');
  }
  return parsed.data;
}

/** Short signature prefix shown in the UI so a user can tell card versions apart. */
export function fingerprint(signed: Pick<SignedCard, 'sig'>): string {
  return signed.sig.slice(0, 8);
}
