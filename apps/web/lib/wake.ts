/**
 * Render's free plan puts a service to sleep after 15 idle minutes; the next request wakes it in
 * up to about a minute. A run queued for a sleeping agent-runner would sit in the queue until
 * something else woke it, so web pings agent-runner and twokey-mcp as it queues each run.
 * Fire-and-forget: the caller never waits, and a failed ping changes nothing.
 */

/** How long a wake ping may stay open (a cold start can take about a minute). */
export const WAKE_TIMEOUT_MS = 90_000;

/** The /healthz URLs to ping: agent-runner's root and twokey-mcp's origin. */
export function wakeTargets(env: { AGENT_RUNNER_URL?: string; MCP_PUBLIC_URL?: string }) {
  const out: string[] = [];
  for (const base of [env.AGENT_RUNNER_URL, env.MCP_PUBLIC_URL]) {
    if (!base) continue;
    const u = new URL('/healthz', new URL(base).origin).toString();
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

/** Sends a GET to each target without waiting for, or failing on, the answer. */
export function wakeServices(targets: readonly string[], fetchImpl: typeof fetch = fetch): void {
  for (const url of targets) {
    void Promise.resolve()
      .then(() =>
        fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(WAKE_TIMEOUT_MS) }),
      )
      .then((res) => res.body?.cancel())
      .catch(() => undefined);
  }
}
