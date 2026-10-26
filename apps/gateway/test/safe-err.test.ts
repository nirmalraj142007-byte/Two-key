import { describe, expect, it } from 'vitest';
import { safeErr } from '../src/app.js';

describe('safeErr', () => {
  it('drops the SQL and params of a database error, keeping the Postgres code', () => {
    const cause = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint_name: 'vault_tokens_user_payment_token',
      detail: 'Key (payment_token_id)=(8kd93jf) already exists.',
    });
    const err = Object.assign(new Error('Failed query: insert ...\nparams: 8kd93jf,CUST-9'), {
      name: 'DrizzleQueryError',
      query: 'insert into "vault_tokens" ...',
      params: ['id', 'user', 'CUST-9', '8kd93jf', 'active'],
      cause,
    });
    const logged = safeErr(err);
    expect(logged).toEqual({
      type: 'DrizzleQueryError',
      message: 'Database query failed',
      pgCode: '23505',
      constraint: 'vault_tokens_user_payment_token',
    });
    expect(JSON.stringify(logged)).not.toContain('8kd93jf');
    expect(JSON.stringify(logged)).not.toContain('CUST-9');
  });

  it('passes other errors through unchanged', () => {
    const err = new Error('boom');
    expect(safeErr(err)).toBe(err);
  });
});
