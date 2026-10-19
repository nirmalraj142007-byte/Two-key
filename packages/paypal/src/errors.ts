import { AppError, ErrorCode } from '@twokey/core';

export interface PayPalErrorDetail {
  issue?: string;
  field?: string;
  description?: string;
}

/** PayPal REST error body; OAuth errors use `error` / `error_description` instead of `name`. */
export interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  details?: PayPalErrorDetail[];
  error?: string;
  error_description?: string;
}

export interface PayPalErrorDetails extends Record<string, unknown> {
  httpStatus: number;
  name: string | undefined;
  issues: string[];
  debug_id: string | undefined;
}

function asBody(body: unknown): PayPalErrorBody {
  if (typeof body === 'string') {
    try {
      return asBody(JSON.parse(body));
    } catch {
      return {};
    }
  }
  return body !== null && typeof body === 'object' ? (body as PayPalErrorBody) : {};
}

/** Maps a non-2xx PayPal response to AppError(UPSTREAM_PAYPAL). 429 and 5xx are retryable. */
export function mapPayPalError(
  res: { status: number; headers?: Record<string, string | undefined> },
  body: unknown,
): AppError {
  const b = asBody(body);
  const name = b.name ?? b.error;
  const issues = (b.details ?? [])
    .map((d) => d.issue)
    .filter((i): i is string => typeof i === 'string');
  const debugId = b.debug_id ?? res.headers?.['paypal-debug-id'];
  const details: PayPalErrorDetails = {
    httpStatus: res.status,
    name,
    issues,
    debug_id: debugId,
  };
  const summary = [name ?? 'UNKNOWN', ...issues].join(' / ');
  return new AppError(ErrorCode.UPSTREAM_PAYPAL, `PayPal ${res.status}: ${summary}`, {
    retryable: res.status === 429 || res.status >= 500,
    details,
  });
}
