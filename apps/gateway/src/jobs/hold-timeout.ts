import { AppError, ErrorCode, type PaymentState } from '@twokey/core';
import { type SettleDeps, voidHeld } from '../services/settle.js';

/**
 * hold.timeout handler: voids the hold if it is still held. Idempotent: a hold that was already
 * approved, denied or voided is a no-op (voidHeld's locked state check answers CONFLICT).
 */
export async function handleHoldTimeout(
  deps: SettleDeps,
  data: { paymentId: string },
): Promise<PaymentState | null> {
  try {
    const { state } = await voidHeld(deps, data.paymentId, 'timer', 'hold_timeout');
    deps.log.info({ paymentId: data.paymentId, state }, 'hold timed out');
    return state;
  } catch (err) {
    if (
      err instanceof AppError &&
      (err.code === ErrorCode.CONFLICT || err.code === ErrorCode.NOT_FOUND)
    ) {
      deps.log.info(
        { paymentId: data.paymentId, reason: err.message },
        'hold timer: nothing to do',
      );
      return null;
    }
    throw err;
  }
}
