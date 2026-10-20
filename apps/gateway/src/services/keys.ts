import type { Env } from '@twokey/core';

export type RuleKeys = Record<string, Buffer>;

/** The key map verifyCard needs: { [RULE_HMAC_KEY_ID]: decoded RULE_HMAC_KEY }. */
export function loadRuleKeys(env: Pick<Env<'gateway'>, 'RULE_HMAC_KEY' | 'RULE_HMAC_KEY_ID'>) {
  const keys: RuleKeys = { [env.RULE_HMAC_KEY_ID]: Buffer.from(env.RULE_HMAC_KEY, 'base64') };
  return keys;
}
