import { type Env, loadEnv } from '@twokey/core';

let cached: Env<'web'> | undefined;

/** Web's validated environment, loaded on first use (never at build time). */
export function webEnv(): Env<'web'> {
  cached ??= loadEnv('web');
  return cached;
}
