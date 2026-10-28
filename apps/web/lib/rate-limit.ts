import { createHash } from 'node:crypto';
import pg from 'pg';
import { RateLimiterPostgres, type RateLimiterRes } from 'rate-limiter-flexible';
import { webEnv } from './env';

/** Hijack box: 5 attempts per IP per rolling hour. */
export const HIJACK_POINTS = 5;
export const HIJACK_WINDOW_S = 60 * 60;

/**
 * The visitor's IP: the first x-forwarded-for entry (Render's proxy puts the client first), else
 * x-real-ip. Only its salted hash is ever stored.
 */
export function clientIp(headers: Headers): string {
  const first = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return first || headers.get('x-real-ip')?.trim() || 'unknown';
}

/** sha256(IP_HASH_SALT + ip), hex. */
export function ipHash(ip: string, salt = webEnv().IP_HASH_SALT): string {
  return createHash('sha256')
    .update(salt + ip)
    .digest('hex');
}

// One limiter (and a two-connection pool) per server process; dev reloads reuse it.
const g = globalThis as { twokeyHijackLimiter?: Promise<RateLimiterPostgres> };

function limiter(): Promise<RateLimiterPostgres> {
  g.twokeyHijackLimiter ??= new Promise<RateLimiterPostgres>((resolve, reject) => {
    const pool = new pg.Pool({ connectionString: webEnv().DATABASE_URL, max: 2 });
    const l: RateLimiterPostgres = new RateLimiterPostgres(
      {
        storeClient: pool,
        storeType: 'pool',
        tableName: 'hijack_rate_limits',
        keyPrefix: 'hijack',
        points: HIJACK_POINTS,
        duration: HIJACK_WINDOW_S,
        clearExpiredByTimeout: true,
      },
      (err?: Error) => (err ? reject(err) : resolve(l)),
    );
  }).catch((err) => {
    g.twokeyHijackLimiter = undefined;
    throw err;
  });
  return g.twokeyHijackLimiter;
}

export type ConsumeResult = { ok: true; left: number } | { ok: false; retryAfterMinutes: number };

function isLimiterRes(x: unknown): x is RateLimiterRes {
  return typeof x === 'object' && x !== null && 'msBeforeNext' in x;
}

/** Takes one point for this IP hash. Database errors propagate (the route fails closed). */
export async function consumeHijackPoint(key: string): Promise<ConsumeResult> {
  try {
    const res = await (await limiter()).consume(key);
    return { ok: true, left: res.remainingPoints };
  } catch (rej) {
    if (isLimiterRes(rej)) {
      return { ok: false, retryAfterMinutes: Math.max(1, Math.ceil(rej.msBeforeNext / 60_000)) };
    }
    throw rej;
  }
}

/** Tries left this hour for this IP hash, without taking one. */
export async function hijackPointsLeft(key: string): Promise<number> {
  const res = await (await limiter()).get(key);
  return res ? Math.max(0, res.remainingPoints) : HIJACK_POINTS;
}
