import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  createLogger,
  ErrorCode,
  formatUSD,
  loadEnv,
  toCents,
  toHttp,
  toPayPalValue,
} from '../src/index.js';

const gatewayEnv = {
  DATABASE_URL: 'postgres://twokey:twokey@localhost:5432/twokey',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_CLIENT_ID: 'client-id',
  PAYPAL_CLIENT_SECRET: 'super-secret-value',
  RULE_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'),
  RULE_HMAC_KEY_ID: 'k1',
  HUMAN_ASSERTION_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
  AGENT_TOKEN_PEPPER: 'pepper',
  VAPID_PUBLIC_KEY: 'vapid-pub',
  VAPID_PRIVATE_KEY: 'vapid-priv',
  WEB_ORIGIN: 'http://localhost:3000',
  PUBLIC_BASE_URL: 'http://localhost:4000',
};

describe('loadEnv secret ownership', () => {
  it('rejects PAYPAL_CLIENT_SECRET on web', () => {
    expect(() => loadEnv('web', { PAYPAL_CLIENT_SECRET: 'x' })).toThrowError(
      /PAYPAL_CLIENT_SECRET may only be set on: gateway/,
    );
  });

  it('rejects ANTHROPIC_API_KEY on mcp', () => {
    expect(() => loadEnv('mcp', { ANTHROPIC_API_KEY: 'x' })).toThrowError(
      /ANTHROPIC_API_KEY may only be set on: web, agent-runner, eval/,
    );
  });

  it('rejects RULE_HMAC_KEY on agent-runner', () => {
    expect(() => loadEnv('agent-runner', { RULE_HMAC_KEY: 'x' })).toThrowError(
      /RULE_HMAC_KEY may only be set on: gateway/,
    );
  });

  it('uses CONFIG_FORBIDDEN_SECRET and never prints the value', () => {
    try {
      loadEnv('web', { PAYPAL_CLIENT_SECRET: 'leaky-value' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe(ErrorCode.CONFIG_FORBIDDEN_SECRET);
      expect((e as AppError).message).not.toContain('leaky-value');
    }
  });

  it('allows PAYPAL_CLIENT_SECRET on gateway', () => {
    const env = loadEnv('gateway', gatewayEnv);
    expect(env.PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('treats empty strings as unset', () => {
    const env = loadEnv('gateway', { ...gatewayEnv, CHANNEL3_API_KEY: '', PORT: '' });
    expect(env.CHANNEL3_API_KEY).toBeUndefined();
    expect(env.PORT).toBe(4000);
  });
});

describe('loadEnv validation', () => {
  it('lists missing keys and never a value', () => {
    try {
      loadEnv('gateway', { PAYPAL_CLIENT_SECRET: 'super-secret-value', RULE_HMAC_KEY: 'short' });
      expect.unreachable();
    } catch (e) {
      const err = e as AppError;
      expect(err.code).toBe(ErrorCode.CONFIG_INVALID);
      expect(err.message).toContain('PAYPAL_CLIENT_ID');
      expect(err.message).toContain('RULE_HMAC_KEY');
      expect(err.message).not.toContain('super-secret-value');
      expect(err.message).not.toContain('short');
    }
  });
});

describe('toHttp', () => {
  it('hides unknown error messages', () => {
    const { status, body } = toHttp(new Error('db password is hunter2'), 'req-1');
    expect(status).toBe(500);
    expect(body).toEqual({
      error: { code: 'INTERNAL', message: 'Internal error', requestId: 'req-1' },
    });
  });

  it('passes AppError code, message and status through', () => {
    const { status, body } = toHttp(new AppError(ErrorCode.NOT_FOUND, 'No such proposal'), 'r2');
    expect(status).toBe(404);
    expect(body.error).toEqual({ code: 'NOT_FOUND', message: 'No such proposal', requestId: 'r2' });
  });

  it('applies default statuses and overrides', () => {
    expect(new AppError(ErrorCode.RULE_BLOCKED, 'x').httpStatus).toBe(200);
    expect(new AppError(ErrorCode.UPSTREAM_PAYPAL, 'x').httpStatus).toBe(502);
    expect(new AppError(ErrorCode.UPSTREAM_PAYPAL, 'x', { httpStatus: 503 }).httpStatus).toBe(503);
  });
});

describe('createLogger', () => {
  it('redacts secrets and tags the service', () => {
    let out = '';
    const stream = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const log = createLogger('gateway', 'info', stream);
    log.info(
      {
        headers: { authorization: 'Bearer abc' },
        req: { token: 'tk_agent_123', vault_id: 'vault-1' },
      },
      'hello',
    );
    expect(out).toContain('[Redacted]');
    expect(out).not.toContain('Bearer abc');
    expect(out).not.toContain('tk_agent_123');
    expect(out).not.toContain('vault-1');
    expect(JSON.parse(out).service).toBe('gateway');
  });
});

describe('money', () => {
  it('parses to cents', () => {
    expect(toCents('54')).toBe(5400);
    expect(toCents('54.5')).toBe(5450);
    expect(toCents('54.00')).toBe(5400);
    expect(toCents('0.07')).toBe(7);
  });

  it('round trips', () => {
    for (const cents of [0, 7, 5400, 6440, 18900]) {
      expect(toCents(toPayPalValue(cents))).toBe(cents);
    }
    expect(toPayPalValue(5400)).toBe('54.00');
  });

  it('formats USD', () => {
    expect(formatUSD(5400)).toBe('$54.00');
    expect(formatUSD(6440)).toBe('$64.40');
  });

  it.each(['-1', '1.234', 'abc', '', '1e3', '1.'])('rejects %j', (bad) => {
    expect(() => toCents(bad)).toThrowError(AppError);
  });

  it('rejects invalid cents', () => {
    expect(() => toPayPalValue(-1)).toThrowError(AppError);
    expect(() => formatUSD(1.5)).toThrowError(AppError);
  });
});
