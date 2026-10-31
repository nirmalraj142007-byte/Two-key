import { createHash } from 'node:crypto';
import pg from 'pg';
import { RateLimiterMemory, RateLimiterPostgres, type RateLimiterRes } from 'rate-limiter-flexible';
import { webEnv } from './env';

/** Hijack box: 5 attempts per IP per rolling hour. */
export const HIJACK_POINTS = 5;
export const HIJACK_WINDOW_S = 60 * 60;

export { clientIp } from './client-ip';

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

/** Sign-in: 5 attempts per IP hash per minute. A successful sign-in clears the count. */
export const LOGIN_POINTS = 5;
export const LOGIN_WINDOW_S = 60;

// In memory: the web service runs as one instance, and a restart only forgives a minute.
const lg = globalThis as { twokeyLoginLimiter?: RateLimiterMemory };
function loginLimiter(): RateLimiterMemory {
  lg.twokeyLoginLimiter ??= new RateLimiterMemory({
    keyPrefix: 'login',
    points: LOGIN_POINTS,
    duration: LOGIN_WINDOW_S,
  });
  return lg.twokeyLoginLimiter;
}

/** Takes one sign-in attempt for this IP hash; false once the minute's 5 are used. */
export async function consumeLoginAttempt(key: string): Promise<boolean> {
  try {
    await loginLimiter().consume(key);
    return true;
  } catch (rej) {
    if (isLimiterRes(rej)) return false;
    throw rej;
  }
}

/** Called after a successful sign-in, so people who type their password right are never slowed. */
export async function clearLoginAttempts(key: string): Promise<void> {
  await loginLimiter().delete(key);
}
