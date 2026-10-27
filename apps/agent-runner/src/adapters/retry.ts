import { AppError, ErrorCode } from '@twokey/core';

export const REQUEST_TIMEOUT_MS = 60_000;
/** NIM eval models (gpt-oss-20b in particular) often take longer than a minute. */
export const NIM_EVAL_TIMEOUT_MS = 120_000;
const BACKOFF_MS = [1000, 4000];

export interface Failure {
  status?: number;
  /** retry-after in seconds, when the provider sent one. */
  retryAfterSeconds?: number;
  /** Network errors and timeouts: worth another try. */
  transient: boolean;
  message: string;
}

export function isRetryable(f: Failure): boolean {
  const s = f.status;
  return f.transient || s === 429 || s === 529 || (s !== undefined && s >= 500);
}

export function retryDelayMs(f: Failure, attempt: number, random = Math.random): number {
  if (f.retryAfterSeconds !== undefined) return Math.min(f.retryAfterSeconds, 30) * 1000;
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 4000;
  return base + Math.floor(random() * 250);
}

/** Runs `call`, retrying retryable failures twice. Anything left over becomes UPSTREAM_LLM. */
export async function withRetry<T>(
  call: () => Promise<T>,
  classify: (err: unknown) => Failure,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const failure = classify(err);
      if (attempt < BACKOFF_MS.length && isRetryable(failure)) {
        await sleep(retryDelayMs(failure, attempt));
        continue;
      }
      throw new AppError(ErrorCode.UPSTREAM_LLM, `Model call failed: ${failure.message}`, {
        retryable: isRetryable(failure),
        ...(failure.status !== undefined ? { details: { status: failure.status } } : {}),
        cause: err,
      });
    }
  }
}

/** Reads status, retry-after and a short message off an SDK error without trusting its shape. */
export function classifyError(err: unknown): Failure {
  const e = err as {
    status?: unknown;
    name?: unknown;
    message?: unknown;
    headers?: unknown;
  };
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const headers = e?.headers as
    | { get?: (k: string) => string | null }
    | Record<string, string>
    | undefined;
  const raw =
    typeof (headers as { get?: unknown } | undefined)?.get === 'function'
      ? (headers as { get: (k: string) => string | null }).get('retry-after')
      : (headers as Record<string, string> | undefined)?.['retry-after'];
  const seconds = raw === null || raw === undefined ? Number.NaN : Number(raw);
  const name = typeof e?.name === 'string' ? e.name : '';
  const message = typeof e?.message === 'string' ? e.message : '';
  const transient =
    status === undefined && /Timeout|Connection|Abort|fetch failed/i.test(name + message);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(Number.isFinite(seconds) ? { retryAfterSeconds: seconds } : {}),
    transient,
    message: message ? message.slice(0, 300) : 'unknown error',
  };
}
