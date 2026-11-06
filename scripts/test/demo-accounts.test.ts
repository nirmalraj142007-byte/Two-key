import { describe, expect, it } from 'vitest';
import { databaseUrlProblem, parseDemoAccounts } from '../demo-lib.js';

describe('parseDemoAccounts', () => {
  it('accepts short names and full emails, in demo order, without duplicates', () => {
    expect(parseDemoAccounts('judge1, maya,MAYA,judge1@twokey.demo')).toEqual([
      'maya@twokey.demo',
      'judge1@twokey.demo',
    ]);
  });

  it('rejects accounts outside the demo tenant', () => {
    expect(() => parseDemoAccounts('maya,hijack@twokey.system')).toThrow(/not a demo account/);
    expect(() => parseDemoAccounts('judge4')).toThrow(/not a demo account/);
  });

  it('rejects an empty list', () => {
    expect(() => parseDemoAccounts(' , ')).toThrow(/no accounts/);
  });
});

describe('databaseUrlProblem', () => {
  const NEON = 'postgresql://owner:s3cret-pw@ep-x.us-west-2.aws.neon.tech/neondb?sslmode=require';

  it('says missing or empty, and where to set it in GitHub Actions', () => {
    const before = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = 'true';
    try {
      for (const v of [undefined, '', '   ']) {
        expect(databaseUrlProblem(v, 'hosted')).toMatch(
          /^DATABASE_URL is missing or empty: set GitHub repository secret PROD_DATABASE_URL/,
        );
      }
    } finally {
      if (before === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = before;
    }
  });

  it('tells a local host apart from production, printing the host but never the URL', () => {
    const local = databaseUrlProblem('postgres://twokey:twokey@localhost:5432/twokey', 'hosted');
    expect(local).toMatch(
      /needs the production database, but DATABASE_URL points at a local host \(localhost\)/,
    );
    expect(local).not.toContain('twokey:twokey');
    expect(databaseUrlProblem(NEON, 'hosted')).toBeNull();
    expect(databaseUrlProblem(NEON, 'prod')).toBeNull();
    const wrongSide = databaseUrlProblem(NEON, 'local');
    expect(wrongSide).toBe(
      '--env local needs a local database, but DATABASE_URL points at ep-x.us-west-2.aws.neon.tech',
    );
    expect(wrongSide).not.toContain('s3cret-pw');
  });

  it('rejects a value that is not a postgres URL without echoing it', () => {
    const msg = databaseUrlProblem('not a url s3cret-pw', 'prod', '/home/me/prod-gateway.env');
    expect(msg).toMatch(/is set but is not a postgres:\/\/ URL \(value not printed\)/);
    expect(msg).toContain('DATABASE_URL in /home/me/prod-gateway.env');
    expect(msg).not.toContain('s3cret-pw');
    expect(databaseUrlProblem('mysql://u:p@db/x', 'prod')).toMatch(/not a postgres:\/\/ URL/);
  });
});
