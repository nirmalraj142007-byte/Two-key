import { webEnv } from '@/lib/env';

/**
 * Only scripted:<name> models can be chosen from the console (E2E and the offline fallback), and
 * not in production unless ALLOW_SCRIPTED=true. The agent runner checks again.
 */
export function scriptedAllowed(model: string): boolean {
  if (!/^scripted:[a-z0-9-]+$/.test(model)) return false;
  return process.env.NODE_ENV !== 'production' || webEnv().ALLOW_SCRIPTED === 'true';
}
