/**
 * `?__state=<name>` forces one UI state so every screen can be screenshotted (e2e/states.spec.ts).
 * Honoured only outside production: in a production build `process.env.NODE_ENV` is inlined as
 * 'production', so this always returns null and the forcing code paths are dead.
 */

export const FORCED_STATE_PARAM = '__state';

type Params = Record<string, string | string[] | undefined> | URLSearchParams | null | undefined;

export function forcedStatesEnabled(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/** The forced state name, or null (always null in production). */
export function readForcedState(searchParams: Params): string | null {
  if (!forcedStatesEnabled() || !searchParams) return null;
  const raw =
    searchParams instanceof URLSearchParams
      ? searchParams.get(FORCED_STATE_PARAM)
      : searchParams[FORCED_STATE_PARAM];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && /^[a-z][a-z-]{0,31}$/.test(value) ? value : null;
}

/** The forced state if it is one this screen knows, else null. */
export function readForced<T extends string>(
  searchParams: Params,
  allowed: readonly T[],
): T | null {
  const state = readForcedState(searchParams);
  return state !== null && (allowed as readonly string[]).includes(state) ? (state as T) : null;
}
