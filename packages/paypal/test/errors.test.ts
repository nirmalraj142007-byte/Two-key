import { readFileSync } from 'node:fs';
import { AppError, ErrorCode } from '@twokey/core';
import { describe, expect, it } from 'vitest';
import { mapPayPalError } from '../src/errors.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('mapPayPalError', () => {
  it('maps a 422 PAYEE_ACCOUNT_RESTRICTED to a non-retryable UPSTREAM_PAYPAL', () => {
    const err = mapPayPalError({ status: 422 }, fixture('422-payee-restricted.json'));
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe(ErrorCode.UPSTREAM_PAYPAL);
    expect(err.retryable).toBe(false);
    expect(err.details).toEqual({
      httpStatus: 422,
      name: 'UNPROCESSABLE_ENTITY',
      issues: ['PAYEE_ACCOUNT_RESTRICTED'],
      debug_id: 'f2a5b0c3d4e61',
    });
    expect(err.message).toBe('PayPal 422: UNPROCESSABLE_ENTITY / PAYEE_ACCOUNT_RESTRICTED');
  });

  it('maps a 500 to a retryable UPSTREAM_PAYPAL with no issues', () => {
    const err = mapPayPalError({ status: 500 }, fixture('500-internal.json'));
    expect(err.code).toBe(ErrorCode.UPSTREAM_PAYPAL);
    expect(err.retryable).toBe(true);
    expect(err.details).toEqual({
      httpStatus: 500,
      name: 'INTERNAL_SERVER_ERROR',
      issues: [],
      debug_id: '90957fca61718',
    });
  });

  it('accepts a raw string body and falls back to the debug-id header', () => {
    const err = mapPayPalError(
      { status: 429, headers: { 'paypal-debug-id': 'hdr123' } },
      'not json',
    );
    expect(err.retryable).toBe(true);
    expect(err.details).toMatchObject({ httpStatus: 429, issues: [], debug_id: 'hdr123' });
  });
});
