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
): { waitMs: number; tokensPerDay?: number; message: string } | undefined {
  const rl = rateLimitError(err);
  if (!rl) return undefined;
  const retryAfter = parseDuration(header(rl.headers, 'retry-after'));
  const resets = [
    parseDuration(header(rl.headers, 'x-ratelimit-reset-tokens')),
    parseDuration(header(rl.headers, 'x-ratelimit-reset-requests')),
  ].filter((n): n is number => n !== undefined);
  const waitMs = retryAfter ?? (resets.length > 0 ? Math.max(...resets) : DEFAULT_WAIT_MS);
  const tpd = /tokens per day \(TPD\): Limit (\d+)/i.exec(rl.message)?.[1];
  return {
    waitMs: waitMs + 250,
    message: rl.message.slice(0, 160),
    ...(tpd ? { tokensPerDay: Number(tpd) } : {}),
  };
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

/** Spaces call starts at least 60s / rpm apart, across every caller that shares it. */
export class Pacer {
  private next = 0;
  private readonly gapMs: number;
  constructor(
    rpm: number,
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {
    if (!(rpm > 0)) throw new AppError(ErrorCode.VALIDATION, 'rpm must be positive');
    this.gapMs = 60_000 / rpm;
  }
  /** Reserves the next slot and waits for it. */
  async take(): Promise<void> {
    const t = this.now();
    const slot = Math.max(t, this.next);
    this.next = slot + this.gapMs;
    if (slot > t) await this.sleep(slot - t);
  }
}

export interface RateLimitedOptions {
  model: string;
  gate: RateGate;
  /** Shared request pacing; taken before every attempt. */
  pacer?: Pacer;
  maxWaitMs: number;
  maxAttempts?: number;
  onWait?: (waitMs: number, message: string) => void;
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
        await o.pacer?.take();
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
          o.onWait?.(rl.waitMs, rl.message);
          o.gate.pause(rl.waitMs);
        }
      }
    },
  };
}

/** Groq free-tier limits for one model (console.groq.com/docs/rate-limits, 2026-10-25). */
export interface ProviderLimits {
  tokensPerMinute: number;
  tokensPerDay: number;
  requestsPerDay: number;
  requestsPerMinute: number;
}

export const GROQ_FREE_LIMITS: Record<string, ProviderLimits> = {
  'openai/gpt-oss-120b': {
    tokensPerMinute: 8_000,
    tokensPerDay: 200_000,
    requestsPerDay: 1_000,
    requestsPerMinute: 30,
  },
};

/** Stops one model's runs when its daily budget is nearly used; rerun the next day to resume. */
export class DailyBudgetStop extends Error {
  constructor(
    readonly model: string,
    readonly reason: string,
  ) {
    super(`${model}: ${reason}`);
  }
}

/** Fraction of the daily limits the eval may use, leaving room for live demo sessions. */
export const DAILY_SHARE = 0.9;

const DAY_MS = 86_400_000;

/**
 * What is left of a daily allowance that refills continuously (capacity per 24 h), after the
 * given uses. Groq behaves this way: on Oct 26 its x-ratelimit-reset-requests was 86.4 s after
 * one call, i.e. one day / 1,000 requests. History older than 24 h cannot matter (the bucket
 * would be full again), so `events` only needs the last day.
 */
export function bucketLeft(
  capacity: number,
  events: readonly { at: number; amount: number }[],
  now: number,
): number {
  const rate = capacity / DAY_MS;
  let level = capacity;
  let prev = now - DAY_MS;
  for (const e of [...events].filter((x) => x.at > now - DAY_MS).sort((a, b) => a.at - b.at)) {
    level = Math.min(capacity, level + (e.at - prev) * rate) - e.amount;
    prev = e.at;
  }
  return Math.min(capacity, level + (now - prev) * rate);
}

/**
 * Client-side pacing under a provider's token and request limits. Per minute it keeps the sum
 * of (estimated) request sizes in the last 60 s under tokensPerMinute and 30 calls; per day it
 * models Groq's continuously refilling daily allowance (bucketLeft), seeded from the database
 * at start (all sessions of the model, live ones included, since they share the key).
 */
export class TokenBudget {
  private minute: { at: number; tokens: number }[] = [];
  private day: { at: number; tokens: number }[] = [];

  constructor(
    readonly model: string,
    readonly limits: ProviderLimits,
    seed: { at: number; tokens: number }[] = [],
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {
    this.day = [...seed];
  }

  private prune(t: number): void {
    this.minute = this.minute.filter((e) => e.at > t - 60_000);
    this.day = this.day.filter((e) => e.at > t - DAY_MS);
  }

  /** What the daily allowance has left now (it refills continuously). */
  available(): { tokens: number; requests: number } {
    const t = this.now();
    this.prune(t);
    return {
      tokens: bucketLeft(
        this.limits.tokensPerDay,
        this.day.map((e) => ({ at: e.at, amount: e.tokens })),
        t,
      ),
      requests: bucketLeft(
        this.limits.requestsPerDay,
        this.day.map((e) => ({ at: e.at, amount: 1 })),
        t,
      ),
    };
  }

  /** Used out of the daily allowance (capacity minus what is left). */
  usedToday(): { tokens: number; requests: number } {
    const left = this.available();
    return {
      tokens: Math.round(this.limits.tokensPerDay - left.tokens),
      requests: Math.round(this.limits.requestsPerDay - left.requests),
    };
  }

  /**
   * True when a run of about `tokens` tokens and `requests` calls fits and still leaves
   * (1 − DAILY_SHARE) of each daily limit for live sessions.
   */
  roomForRun(tokens: number, requests: number): boolean {
    const left = this.available();
    return (
      left.tokens - tokens >= this.limits.tokensPerDay * (1 - DAILY_SHARE) &&
      left.requests - requests >= this.limits.requestsPerDay * (1 - DAILY_SHARE)
    );
  }

  /** Milliseconds until the daily allowance holds `tokens` and `requests` (linear refill). */
  msUntilAvailable(tokens: number, requests: number): number {
    const left = this.available();
    const tokenRate = this.limits.tokensPerDay / DAY_MS;
    const requestRate = this.limits.requestsPerDay / DAY_MS;
    return Math.ceil(
      Math.max(0, (tokens - left.tokens) / tokenRate, (requests - left.requests) / requestRate),
    );
  }

  /** Milliseconds until roomForRun(tokens, requests) is true. */
  msUntilRoomForRun(tokens: number, requests: number): number {
    return this.msUntilAvailable(
      tokens + this.limits.tokensPerDay * (1 - DAILY_SHARE),
      requests + this.limits.requestsPerDay * (1 - DAILY_SHARE),
    );
  }

  /**
   * Sleeps, in chunks of at most `chunkMs`, until a run of about `tokens` tokens and `requests`
   * calls fits with the 10% headroom kept. Returns false if `shouldStop` turns true meanwhile.
   */
  async waitForRoomForRun(
    tokens: number,
    requests: number,
    o: {
      shouldStop?: () => boolean;
      onWait?: (ms: number) => void;
      chunkMs?: number;
    } = {},
  ): Promise<boolean> {
    if (
      tokens > this.limits.tokensPerDay * DAILY_SHARE ||
      requests > this.limits.requestsPerDay * DAILY_SHARE
    ) {
      throw new DailyBudgetStop(this.model, 'one run needs more than the daily allowance');
    }
    let told = false;
    for (;;) {
      const ms = this.msUntilRoomForRun(tokens, requests);
      if (ms <= 0) return true;
      if (o.shouldStop?.()) return false;
      if (!told) {
        o.onWait?.(ms);
        told = true;
      }
      await this.sleep(Math.min(ms, o.chunkMs ?? 60_000));
    }
  }

  /** Waits until a request of `estimate` tokens fits the minute window and the day's allowance. */
  async reserve(estimate: number): Promise<{ at: number; tokens: number }> {
    if (estimate > this.limits.tokensPerMinute) {
      throw new DailyBudgetStop(
        this.model,
        `one request needs ~${estimate} tokens, over the ${this.limits.tokensPerMinute}/min limit`,
      );
    }
    for (;;) {
      const t = this.now();
      this.prune(t);
      const wait = this.msUntilAvailable(estimate, 1);
      if (wait > 0) {
        // Mid-run the allowance ran short (live sessions share it): wait for the refill.
        await this.sleep(Math.min(wait, 60_000));
        continue;
      }
      const inMinute = this.minute.reduce((a, e) => a + e.tokens, 0);
      const callsInMinute = this.minute.length;
      if (
        inMinute + estimate <= this.limits.tokensPerMinute &&
        callsInMinute < this.limits.requestsPerMinute
      ) {
        const entry = { at: t, tokens: estimate };
        this.minute.push(entry);
        this.day.push(entry);
        return entry;
      }
      const oldest = this.minute[0];
      await this.sleep(oldest ? Math.max(250, oldest.at + 60_000 - t + 50) : 1000);
    }
  }

  /** Replaces a reservation's estimate with the tokens the provider reported. */
  settle(entry: { at: number; tokens: number }, actual: number): void {
    entry.tokens = actual;
  }
}

/** Rough request size: input text / 4 plus the output cap (Groq counts max_tokens). */
export function estimateRequestTokens(input: unknown, maxOutputTokens: number): number {
  return Math.ceil(JSON.stringify(input).length / 4) + maxOutputTokens;
}

/** Paces every step of `adapter` through `budget`. */
export function budgeted(adapter: ModelAdapter, budget: TokenBudget): ModelAdapter {
  return {
    id: adapter.id,
    async step(input) {
      const entry = await budget.reserve(
        estimateRequestTokens(
          { system: input.system, messages: input.messages, tools: input.tools },
          input.maxOutputTokens,
        ),
      );
      // A refused call keeps its estimate: it still counted against the minute.
      const res = await adapter.step(input);
      budget.settle(entry, res.usage.inputTokens + res.usage.outputTokens);
      return res;
    },
  };
}
