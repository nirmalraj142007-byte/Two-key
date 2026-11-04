import { describe, expect, it } from 'vitest';
import { parseDemoAccounts } from '../demo-lib.js';

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
