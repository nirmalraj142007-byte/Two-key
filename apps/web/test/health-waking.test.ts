import { describe, expect, it } from 'vitest';
import { healthOf } from '@/components/twokey/HealthBanner';
import { createGatewayHealthState, GATEWAY_WAKE_GRACE_MS } from '@/lib/gateway-wake';
import { allWakeTargets } from '@/lib/wake';

// Free hosting: a gateway waking from sleep must read as "waking", never as degraded, for up to
// GATEWAY_WAKE_GRACE_MS; only a gateway down for longer is degraded.

describe('gateway wake grace', () => {
  it('says waking for the grace period after the first failed check, then down', () => {
    const s = createGatewayHealthState();
    expect(s.unreachable(1_000)).toBe('waking');
    expect(s.unreachable(1_000 + GATEWAY_WAKE_GRACE_MS - 1)).toBe('waking');
    expect(s.unreachable(1_000 + GATEWAY_WAKE_GRACE_MS)).toBe('down');
  });

  it('starts the grace again once the gateway has answered', () => {
    const s = createGatewayHealthState(10);
    expect(s.unreachable(0)).toBe('waking');
    expect(s.unreachable(20)).toBe('down');
    s.reachable();
    expect(s.unreachable(30)).toBe('waking');
  });

  it('keeps the grace under 90 s, so a real outage still shows within about 90 s', () => {
    expect(GATEWAY_WAKE_GRACE_MS).toBeLessThanOrEqual(90_000);
  });
});

describe('health banner state', () => {
  it('maps the proxy answer to ok, waking or degraded', () => {
    expect(healthOf({ degraded: false })).toBe('ok');
    expect(healthOf({ degraded: false, waking: true })).toBe('waking');
    expect(healthOf({ degraded: true, reason: 'paypal_unreachable' })).toBe('degraded');
  });
});

describe('allWakeTargets', () => {
  it('pings the gateway as well as agent-runner and twokey-mcp, once each', () => {
    expect(
      allWakeTargets({
        GATEWAY_URL: 'https://gw.example.test',
        AGENT_RUNNER_URL: 'https://runner.example.test/run',
        MCP_PUBLIC_URL: 'https://mcp.example.test/mcp',
      }),
    ).toEqual([
      'https://gw.example.test/healthz',
      'https://runner.example.test/healthz',
      'https://mcp.example.test/healthz',
    ]);
  });
});
