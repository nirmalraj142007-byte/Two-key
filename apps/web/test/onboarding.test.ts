import { AppError, ErrorCode } from '@twokey/core';
import { describe, expect, it } from 'vitest';
import {
  CANCELLED_MESSAGE,
  checkReturn,
  EXPIRED_MESSAGE,
  MISMATCH_MESSAGE,
  returnedSetupTokenId,
  setupCookieValue,
  toFailure,
} from '../lib/onboarding';

const MAYA = '0190a1b2-0000-7000-8000-000000000001';
const EVE = '0190a1b2-0000-7000-8000-000000000002';
const MINE = '8XK12345AB678901C';
const OTHER = '3JT98765ZY432109Q';

describe('PayPal return page: invariant 14', () => {
  const cookie = setupCookieValue(MAYA, MINE);

  it('accepts the setup token created for this user session', () => {
    expect(checkReturn({ query: { approval_token_id: MINE }, cookie, userId: MAYA })).toEqual({
      kind: 'ok',
      setupTokenId: MINE,
    });
  });

  it('rejects a returned setup token that is not the one created for this session', () => {
    expect(checkReturn({ query: { approval_token_id: OTHER }, cookie, userId: MAYA })).toEqual({
      kind: 'mismatch',
    });
    // also when PayPal uses another parameter name
    expect(checkReturn({ query: { token: OTHER }, cookie, userId: MAYA }).kind).toBe('mismatch');
  });

  it("rejects another user's session cookie (foreign approval)", () => {
    expect(checkReturn({ query: { approval_token_id: MINE }, cookie, userId: EVE }).kind).toBe(
      'mismatch',
    );
  });

  it('rejects a return with no session cookie (stale approval)', () => {
    for (const c of [undefined, '', 'garbage', `${MAYA}.`]) {
      expect(
        checkReturn({ query: { approval_token_id: MINE }, cookie: c, userId: MAYA }).kind,
      ).toBe('mismatch');
    }
  });

  it('uses the session token when PayPal appends no ID', () => {
    expect(checkReturn({ query: {}, cookie, userId: MAYA })).toEqual({
      kind: 'ok',
      setupTokenId: MINE,
    });
  });

  it('reload after success: the saved approval shows "saved", never an error', () => {
    const saved = setupCookieValue(MAYA, MINE, true);
    // the same return URL again (reload / Back), with or without PayPal's params
    expect(
      checkReturn({ query: { approval_token_id: MINE }, cookie: saved, userId: MAYA }),
    ).toEqual({ kind: 'saved' });
    expect(checkReturn({ query: {}, cookie: saved, userId: MAYA })).toEqual({ kind: 'saved' });
    // a different approval, another user's marker or a forged state is still a mismatch
    expect(
      checkReturn({ query: { approval_token_id: OTHER }, cookie: saved, userId: MAYA }).kind,
    ).toBe('mismatch');
    expect(
      checkReturn({ query: { approval_token_id: MINE }, cookie: saved, userId: EVE }).kind,
    ).toBe('mismatch');
    expect(checkReturn({ query: {}, cookie: `${MAYA}.${MINE}.forged`, userId: MAYA }).kind).toBe(
      'mismatch',
    );
  });

  it('PayPal cancel shows the cancelled state, whatever else is in the URL or cookie', () => {
    for (const cookie of [undefined, setupCookieValue(MAYA, MINE), setupCookieValue(EVE, OTHER)]) {
      expect(
        checkReturn({ query: { cancelled: '1', approval_token_id: MINE }, cookie, userId: MAYA }),
      ).toEqual({ kind: 'cancelled' });
    }
    expect(CANCELLED_MESSAGE).toBe('You cancelled in PayPal. Nothing was saved.');
  });

  it('an expired approval says "start again", never the generic error', () => {
    const f = toFailure(
      new AppError(ErrorCode.NOT_FOUND, 'PayPal approval expired or not found'),
      'paypal',
    );
    expect(f.message).toBe(EXPIRED_MESSAGE);
    expect(f.message).toContain('start again');
    expect(f.next).toEqual({ label: 'Start again', href: '/onboarding/paypal' });
  });

  it('reads the cancel return before anything else', () => {
    expect(checkReturn({ query: { cancelled: '1' }, cookie: undefined, userId: MAYA })).toEqual({
      kind: 'cancelled',
    });
  });

  it('reads approval params defensively', () => {
    expect(returnedSetupTokenId({ approval_token_id: [MINE, OTHER] })).toBe(MINE);
    expect(returnedSetupTokenId({ approval_token_id: '  ' })).toBeUndefined();
    expect(returnedSetupTokenId({ approval_token_id: '<script>' })).toBeUndefined();
    expect(returnedSetupTokenId({ setup_token_id: MINE })).toBe(MINE);
  });

  it('shows the mismatch sentence when the gateway does not know the setup token', () => {
    const f = toFailure(new AppError(ErrorCode.NOT_FOUND, 'Setup token not found'), 'paypal');
    expect(f.message).toBe(MISMATCH_MESSAGE);
    expect(f.message).toBe("This approval doesn't match your session — start again");
    expect(f.next.href).toBe('/onboarding/paypal');
  });
});

describe('toFailure', () => {
  it('maps 409 Connect PayPal first to a link to step 1', () => {
    const f = toFailure(new AppError(ErrorCode.CONFLICT, 'Connect PayPal first'), 'agent');
    expect(f).toEqual({
      message: 'Connect PayPal first.',
      next: { label: 'Connect PayPal', href: '/onboarding/paypal' },
    });
  });

  it("shows PayPal's message without the status prefix", () => {
    const f = toFailure(
      new AppError(ErrorCode.UPSTREAM_PAYPAL, 'PayPal 422: Payer cannot be vaulted (DECLINED)'),
      'paypal',
    );
    expect(f.message).toBe(
      "PayPal didn't accept the request. PayPal said: Payer cannot be vaulted (DECLINED)",
    );
    expect(f.next.href).toBeUndefined();
  });

  it('never shows an error code', () => {
    for (const code of Object.values(ErrorCode)) {
      const f = toFailure(new AppError(code, 'x'), 'rules');
      expect(f.message).not.toContain(code);
      expect(f.next.label.length).toBeGreaterThan(0);
    }
    expect(toFailure(new Error('db password leaked'), 'rules').message).not.toContain('leaked');
  });
});
