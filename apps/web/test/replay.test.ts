import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReplayConsole, type ReplayFrame, ReplayView } from '@/components/twokey/ReplayConsole';
import { fixtureFinalProposals, fixtureSteps } from '@/lib/state-fixtures';
import {
  fallbackReason,
  GoldenRunSchema,
  MAX_EVENT_GAP_MS,
  REPLAY_FALLBACK_TEXT,
  rebase,
  replayTimeline,
} from '../lib/golden-run';

const golden = GoldenRunSchema.parse(
  JSON.parse(readFileSync(new URL('../public/golden-run.json', import.meta.url), 'utf8')),
);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function bannerFirst(html: string) {
  expect(html).toContain(REPLAY_FALLBACK_TEXT);
  expect(html).toContain('data-tone="replay"');
  // The banner comes before any recorded content.
  expect(html.indexOf('data-slot="banner"')).toBeLessThan(html.indexOf('replay-chat-title'));
}

describe('replayed console run', () => {
  const states: ReplayFrame['status'][] = ['loading', 'playing', 'done', 'unavailable'];

  it.each(states)('always renders the replay banner (%s)', (status) => {
    const full = status === 'playing' || status === 'done';
    const frame: ReplayFrame = {
      status,
      message: full ? 'Running shoes, size 10' : null,
      steps: full ? fixtureSteps() : [],
      cards: full ? fixtureFinalProposals() : [],
      history: full ? fixtureFinalProposals() : [],
    };
    bannerFirst(renderToStaticMarkup(createElement(ReplayView, { frame, onReplay: () => {} })));
  });

  it('renders the banner for the recorded golden run and while it loads', () => {
    bannerFirst(renderToStaticMarkup(createElement(ReplayConsole, { initialRun: golden })));
    bannerFirst(renderToStaticMarkup(createElement(ReplayConsole)));
  });

  it('the recording has the three beats and no live-looking IDs', () => {
    expect(golden.beats.map((b) => b.name)).toEqual(['happy', 'attack', 'anomaly']);
    const text = JSON.stringify(golden);
    expect(text).not.toMatch(UUID);
    for (const m of text.matchAll(/"(orderId|authorizationId|captureId)":"([^"]+)"/g)) {
      expect(m[2]).toMatch(/^REPLAY-/);
    }
    const timeline = replayTimeline(golden, new Date());
    const finalState = (beat: number) =>
      timeline
        .filter((e) => e.beat === beat && 'state' in e.event.data)
        .map((e) => (e.event.data as { state: string }).state)
        .at(-1);
    expect([finalState(0), finalState(1), finalState(2)]).toEqual([
      'captured',
      'blocked',
      'voided',
    ]);
    const ats = timeline.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => a - b));
    for (let i = 1; i < timeline.length; i++) {
      const gap = (ats[i] ?? 0) - (ats[i - 1] ?? 0);
      if (timeline[i]?.beat === timeline[i - 1]?.beat)
        expect(gap).toBeLessThanOrEqual(MAX_EVENT_GAP_MS);
    }
  });

  it('rebases timestamps onto the playback start', () => {
    const moved = rebase({ at: '2026-11-02T00:00:00.000Z', id: 'REPLAY-x', n: 1 }, 60_000);
    expect(moved).toEqual({ at: '2026-11-02T00:01:00.000Z', id: 'REPLAY-x', n: 1 });
  });

  it('falls back when forced or when PayPal is degraded, never otherwise', () => {
    expect(fallbackReason({ demoFallback: 'replay', paypalDegraded: false })).toBe('forced');
    expect(fallbackReason({ demoFallback: undefined, paypalDegraded: true })).toBe('paypal');
    expect(fallbackReason({ demoFallback: 'off', paypalDegraded: false })).toBeNull();
    expect(fallbackReason({ demoFallback: undefined, paypalDegraded: false })).toBeNull();
  });
});
