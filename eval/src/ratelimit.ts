import type { ModelAdapter } from '@twokey/agent-runner/adapters';
import { AppError, ErrorCode } from '@twokey/core';

/** Groq durations: "7.66s", "2m59.56s", "1h2m3s", "250ms". */
export function parseDuration(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = '';
  for (let m = re.exec(v); m; m = re.exec(v)) {
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3_600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
    matched += m[0];
  }
  return matched === v ? Math.round(total) : undefined;
}

type HeaderBag = { get?: (k: string) => string | null } | Record<string, string> | undefined;

function header(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  const value =
    typeof (headers as { get?: unknown }).get === 'function'
      ? (headers as { get: (k: string) => string | null }).get(name)
      : (headers as Record<string, string>)[name];
  return value ?? undefined;
}

/** The last x-ratelimit-* values seen for one model. */
export interface RateLimitSnapshot {
  limitRequests?: number;
  limitTokens?: number;
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequests?: string;
  resetTokens?: string;
  /** Tokens per day, when a 429 message stated it (Groq does not send it as a header). */
  limitTokensPerDay?: number;
}

export function readRateLimits(headers: HeaderBag): RateLimitSnapshot {
  const num = (name: string) => {
    const raw = header(headers, name);
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const out: RateLimitSnapshot = {};
  const lr = num('x-ratelimit-limit-requests');
  const lt = num('x-ratelimit-limit-tokens');
  const rr = num('x-ratelimit-remaining-requests');
  const rt = num('x-ratelimit-remaining-tokens');
  const xr = header(headers, 'x-ratelimit-reset-requests');
  const xt = header(headers, 'x-ratelimit-reset-tokens');
  if (lr !== undefined) out.limitRequests = lr;
  if (lt !== undefined) out.limitTokens = lt;
  if (rr !== undefined) out.remainingRequests = rr;
  if (rt !== undefined) out.remainingTokens = rt;
  if (xr) out.resetRequests = xr;
  if (xt) out.resetTokens = xt;
  return out;
}

/** The provider error behind an adapter failure, if it was a 429. */
function rateLimitError(err: unknown): { headers: HeaderBag; message: string } | undefined {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const x = e as { status?: unknown; headers?: unknown; message?: unknown };
    if (x.status === 429) {
      return {
        headers: x.headers as HeaderBag,
        message: typeof x.message === 'string' ? x.message : '',
      };
    }
    if (e instanceof AppError && (e.details as { status?: unknown } | undefined)?.status === 429) {
      const cause = (e as { cause?: unknown }).cause as { headers?: unknown; message?: unknown };
      return {
        headers: cause?.headers as HeaderBag,
        message: typeof cause?.message === 'string' ? cause.message : e.message,
      };
    }
  }
  return undefined;
}

const DEFAULT_WAIT_MS = 15_000;

/** How long to wait after a 429: retry-after, else the later of the two reset headers. */
export function rateLimitWaitMs(
  err: unknown,
): { waitMs: number; tokensPerDay?: number } | undefined {
  const rl = rateLimitError(err);
  if (!rl) return undefined;
  const retryAfter = parseDuration(header(rl.headers, 'retry-after'));
  const resets = [
    parseDuration(header(rl.headers, 'x-ratelimit-reset-tokens')),
    parseDuration(header(rl.headers, 'x-ratelimit-reset-requests')),
  ].filter((n): n is number => n !== undefined);
  const waitMs = retryAfter ?? (resets.length > 0 ? Math.max(...resets) : DEFAULT_WAIT_MS);
  const tpd = /tokens per day \(TPD\): Limit (\d+)/i.exec(rl.message)?.[1];
  return { waitMs: waitMs + 250, ...(tpd ? { tokensPerDay: Number(tpd) } : {}) };
}

/** Thrown when the wait would be longer than allowed (a daily limit): the model's runs stop. */
export class RateLimitStop extends Error {
  constructor(
    readonly model: string,
    readonly waitMs: number,
  ) {
    super(`${model}: rate limited for ${Math.ceil(waitMs / 60_000)} min`);
  }
}

/** One per model: a 429 seen by any worker pauses every worker of that model. */
export class RateGate {
  private until = 0;
  constructor(private readonly sleep: (ms: number) => Promise<void> = defaultSleep) {}
  pause(ms: number, now = Date.now()): void {
    this.until = Math.max(this.until, now + ms);
  }
  /** Sleeps out the current pause; a pause added meanwhile is caught by the next 429. */
  async ready(now = Date.now()): Promise<void> {
    const left = this.until - now;
    if (left > 0) await this.sleep(left);
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface RateLimitedOptions {
  model: string;
  gate: RateGate;
  maxWaitMs: number;
  maxAttempts?: number;
  onWait?: (waitMs: number) => void;
  onTokensPerDay?: (limit: number) => void;
}

/**
 * Wraps an adapter so a Groq 429 waits (retry-after / x-ratelimit-reset-*) and retries the same
 * step instead of failing the run. Longer than maxWaitMs (a daily limit) throws RateLimitStop.
 */
export function rateLimited(adapter: ModelAdapter, o: RateLimitedOptions): ModelAdapter {
  const maxAttempts = o.maxAttempts ?? 30;
  return {
    id: adapter.id,
    async step(input) {
      for (let attempt = 1; ; attempt++) {
        await o.gate.ready();
        try {
          return await adapter.step(input);
        } catch (err) {
          const rl = rateLimitWaitMs(err);
          if (!rl) throw err;
          if (rl.tokensPerDay !== undefined) o.onTokensPerDay?.(rl.tokensPerDay);
          if (rl.waitMs > o.maxWaitMs) throw new RateLimitStop(o.model, rl.waitMs);
          if (attempt >= maxAttempts) {
            throw new AppError(ErrorCode.UPSTREAM_LLM, `${o.model}: still rate limited`, {
              retryable: true,
              cause: err,
            });
          }
          o.onWait?.(rl.waitMs);
          o.gate.pause(rl.waitMs);
        }
      }
    },
  };
}
