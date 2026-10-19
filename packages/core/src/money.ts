import { AppError, ErrorCode } from './errors.js';

const DECIMAL = /^\d+(\.\d{1,2})?$/;

/** Parses a decimal dollar string ('54', '54.5', '54.00') into integer cents. */
export function toCents(value: string): number {
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new AppError(
      ErrorCode.VALIDATION,
      'Amount must be a non-negative number with at most 2 decimals',
    );
  }
  const [whole = '0', frac = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new AppError(ErrorCode.VALIDATION, 'Amount is too large');
  }
  return cents;
}

function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new AppError(ErrorCode.VALIDATION, 'Cents must be a non-negative integer');
  }
}

/** Integer cents to PayPal's decimal string: 5400 -> '54.00'. */
export function toPayPalValue(cents: number): string {
  assertCents(cents);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** Integer cents to display text: 5400 -> '$54.00'. */
export function formatUSD(cents: number): string {
  assertCents(cents);
  const dollars = Math.floor(cents / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${dollars}.${String(cents % 100).padStart(2, '0')}`;
}
