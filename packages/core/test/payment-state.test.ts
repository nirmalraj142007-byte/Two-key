import { describe, expect, it } from 'vitest';
import {
  canTransition,
  PAYMENT_STATES,
  type PaymentState,
  TERMINAL,
  webhookTarget,
} from '../src/payment-state.js';

/** The table from the phase 4 spec (phase 9 adds the two *_requested -> expired exits),
 * written out independently of the implementation. */
const ALLOWED: Record<PaymentState, PaymentState[]> = {
  authorizing: ['authorized', 'held', 'failed', 'voided', 'captured'],
  authorized: ['held', 'capture_requested', 'captured', 'void_requested', 'voided', 'expired'],
  held: ['capture_requested', 'captured', 'void_requested', 'voided', 'expired'],
  capture_requested: ['captured', 'denied', 'failed', 'expired'],
  void_requested: ['voided', 'expired'],
  captured: [],
  voided: [],
  expired: [],
  denied: [],
  failed: [],
};

const pairs = PAYMENT_STATES.flatMap((from) => PAYMENT_STATES.map((to) => [from, to] as const));

describe('canTransition', () => {
  it('covers all 100 state pairs', () => {
    expect(PAYMENT_STATES).toHaveLength(10);
    expect(pairs).toHaveLength(100);
  });

  it.each(pairs)('%s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED[from].includes(to));
  });

  it('terminal states have no outgoing transitions', () => {
    expect([...TERMINAL].sort()).toEqual(['captured', 'denied', 'expired', 'failed', 'voided']);
    for (const from of TERMINAL) {
      for (const to of PAYMENT_STATES) expect(canTransition(from, to)).toBe(false);
    }
  });

  it('never allows a state to transition to itself', () => {
    for (const s of PAYMENT_STATES) expect(canTransition(s, s)).toBe(false);
  });
});

describe('webhookTarget', () => {
  it.each([
    ['PAYMENT.AUTHORIZATION.CREATED', 'authorized'],
    ['PAYMENT.AUTHORIZATION.VOIDED', 'voided'],
    ['PAYMENT.CAPTURE.COMPLETED', 'captured'],
    ['PAYMENT.CAPTURE.PENDING', 'capture_requested'],
    ['PAYMENT.CAPTURE.DENIED', 'denied'],
  ])('%s -> %s', (type, state) => {
    expect(webhookTarget(type)).toBe(state);
  });

  it.each([
    'VAULT.PAYMENT-TOKEN.CREATED',
    'VAULT.PAYMENT-TOKEN.DELETED',
    'CHECKOUT.ORDER.APPROVED',
    'toString',
    '',
  ])('%s -> null', (type) => {
    expect(webhookTarget(type)).toBeNull();
  });
});
