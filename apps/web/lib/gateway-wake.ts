/**
 * Free hosting: Render's free gateway sleeps after 15 idle minutes and takes up to about a
 * minute to answer again. The health proxy calls an unreachable gateway "waking" for this long
 * after the first failed check, and "degraded" only after that.
 */
export const GATEWAY_WAKE_GRACE_MS = 90_000;

/** Tracks when the gateway stopped answering. Pure apart from its own state; pass `now` in. */
export function createGatewayHealthState(graceMs = GATEWAY_WAKE_GRACE_MS) {
  let since: number | null = null;
  return {
    reachable() {
      since = null;
    },
    /** One failed check at `now`: still inside the wake-up grace, or down for longer. */
    unreachable(now: number): 'waking' | 'down' {
      since ??= now;
      return now - since < graceMs ? 'waking' : 'down';
    },
  };
}

// One per server process; dev reloads reuse it through globalThis.
const g = globalThis as { twokeyGatewayHealth?: ReturnType<typeof createGatewayHealthState> };
g.twokeyGatewayHealth ??= createGatewayHealthState();
export const gatewayHealthState = g.twokeyGatewayHealth;
