/**
 * Free hosting (Render's free plan): agent-runner and twokey-mcp sleep after 15 idle minutes and
 * take up to about a minute to wake. These rules decide what the console and the hijack box say
 * while a run has shown no step yet, and when the hijack box may fall back to a recorded run.
 * Client-safe: no server imports.
 */

/** A run with no step after this long is probably waiting for a sleeping server. */
export const WAKING_AFTER_MS = 5000;
export const WAKING_TEXT = 'Waking up the free server — this can take up to a minute';

/** Hijack box: a live run that has started but has no result by then may switch to a replay. */
export const HIJACK_SLOW_MS = 30_000;
/** Hijack box: a live run that has not started (services waking) gets this long before a replay. */
export const HIJACK_WAKING_LIMIT_MS = 75_000;

/** Whether to show WAKING_TEXT: nothing from the agent yet, and the short wait is over. */
export function isWaking(waitedMs: number, started: boolean): boolean {
  return !started && waitedMs >= WAKING_AFTER_MS;
}

/**
 * Whether a live hijack attempt without a result may switch to a recorded run. A cold start must
 * not do it early: until the agent's first step arrives the run gets HIJACK_WAKING_LIMIT_MS.
 */
export function hijackReplayDue(waitedMs: number, started: boolean): boolean {
  return waitedMs >= (started ? HIJACK_SLOW_MS : HIJACK_WAKING_LIMIT_MS);
}
