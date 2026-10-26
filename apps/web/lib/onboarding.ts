import { AppError, ErrorCode } from '@twokey/core';
import { EXPIRED_MESSAGE, MISMATCH_MESSAGE } from './onboarding-copy';

/**
 * Holds the setup token created for this browser's signed-in user until PayPal sends them back:
 * `<userId>.<setupTokenId>` while pending, `<userId>.<setupTokenId>.saved` once the wallet is saved
 * (so reloading the return page shows "Saved" instead of an error).
 */
export const SETUP_COOKIE = 'tk_setup';
export const SETUP_COOKIE_MAX_AGE_S = 3 * 60 * 60;
export const SAVED_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const SAVED = 'saved';

/** agent_sessions.model for tokens handed to the user's own MCP client. */
export const EXTERNAL_MODEL = 'external';

export {
  CANCELLED_MESSAGE,
  EXPIRED_MESSAGE,
  MISMATCH_MESSAGE,
  SAVED_MESSAGE,
} from './onboarding-copy';

/** One plain sentence plus the one thing to do next. No `href` means "try again here". */
export interface Failure {
  message: string;
  next: { label: string; href?: string };
}

export function setupCookieValue(userId: string, setupTokenId: string, saved = false): string {
  return saved ? `${userId}.${setupTokenId}.${SAVED}` : `${userId}.${setupTokenId}`;
}

type Query = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  const trimmed = v?.trim();
  return trimmed && /^[A-Za-z0-9_-]{1,100}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * The setup-token ID PayPal appended to the return URL. Read defensively: PayPal has used
 * `approval_token_id` for vault setup tokens and `token` for order approvals.
 */
export function returnedSetupTokenId(query: Query): string | undefined {
  return first(query.approval_token_id) ?? first(query.token) ?? first(query.setup_token_id);
}

export type ReturnCheck =
  | { kind: 'ok'; setupTokenId: string }
  | { kind: 'saved' }
  | { kind: 'cancelled' }
  | { kind: 'mismatch' };

/**
 * CLAUDE.md invariant 14: only the setup token created for THIS user's session is accepted.
 * A missing cookie, another user's cookie, or a returned ID that differs is a mismatch.
 * Coming back to an approval this browser already saved (reload, Back) is `saved`, not an error.
 */
export function checkReturn(input: {
  query: Query;
  cookie: string | undefined;
  userId: string;
}): ReturnCheck {
  if (first(input.query.cancelled) === '1') return { kind: 'cancelled' };
  const [owner = '', created = '', state, ...rest] = (input.cookie ?? '').split('.');
  if (!owner || !created || rest.length > 0 || owner !== input.userId) return { kind: 'mismatch' };
  if (state !== undefined && state !== SAVED) return { kind: 'mismatch' };
  const returned = returnedSetupTokenId(input.query);
  if (returned !== undefined && returned !== created) return { kind: 'mismatch' };
  return state === SAVED ? { kind: 'saved' } : { kind: 'ok', setupTokenId: created };
}

const RETRY = { label: 'Try again' } as const;

function unknownFailure(context: 'paypal' | 'rules' | 'agent'): Failure {
  return context === 'paypal'
    ? { message: 'Your PayPal wallet was not saved. Try again.', next: RETRY }
    : { message: 'Something went wrong on our side. Nothing was changed.', next: RETRY };
}

/** Maps anything thrown by a gateway call to a sentence a person can act on. Never shows codes. */
export function toFailure(err: unknown, context: 'paypal' | 'rules' | 'agent'): Failure {
  if (!(err instanceof AppError)) return unknownFailure(context);
  switch (err.code) {
    case ErrorCode.UNAUTHENTICATED:
      return { message: 'Your sign-in has expired.', next: { label: 'Sign in', href: '/login' } };
    case ErrorCode.CONFLICT:
      if (err.message === 'Connect PayPal first') {
        return {
          message: 'Connect PayPal first.',
          next: { label: 'Connect PayPal', href: '/onboarding/paypal' },
        };
      }
      if (err.message === 'Sign your rules first') {
        return {
          message: 'Sign your rules first.',
          next: { label: 'Build my rules', href: '/rules/new' },
        };
      }
      return {
        message: 'These rules were already signed or replaced.',
        next: { label: 'Build new rules', href: '/rules/new' },
      };
    case ErrorCode.NOT_FOUND:
      if (context === 'paypal') {
        return {
          message: /expired/i.test(err.message) ? EXPIRED_MESSAGE : MISMATCH_MESSAGE,
          next: { label: 'Start again', href: '/onboarding/paypal' },
        };
      }
      return {
        message: "We couldn't find these rules.",
        next: { label: 'Build new rules', href: '/rules/new' },
      };
    case ErrorCode.RULE_CARD_INVALID:
      return {
        message: 'These rules are incomplete or already expired.',
        next: { label: 'Build new rules', href: '/rules/new' },
      };
    case ErrorCode.FORBIDDEN:
      return {
        message: "This account can't change that.",
        next: { label: 'Back to start', href: '/onboarding/paypal' },
      };
    case ErrorCode.RATE_LIMITED:
    case ErrorCode.BUDGET_EXCEEDED:
      return { message: 'Too many tries right now. Wait a minute.', next: RETRY };
    case ErrorCode.UPSTREAM_PAYPAL: {
      // "PayPal 422: Some reason (ISSUE)" -> "Some reason (ISSUE)"
      const text = err.message.replace(/^PayPal \d{3}: /, '').trim();
      const said = text && text !== 'Internal error' ? ` PayPal said: ${text}` : '';
      return { message: `PayPal didn't accept the request.${said}`, next: RETRY };
    }
    case ErrorCode.VALIDATION:
      return { message: err.message, next: RETRY };
    default:
      return unknownFailure(context);
  }
}
