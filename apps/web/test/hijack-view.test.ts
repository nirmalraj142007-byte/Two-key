import { describe, expect, it } from 'vitest';
import type { StepEntry } from '../lib/console-view';
import {
  attackerLine,
  EMPTY_ATTEMPT,
  followedLine,
  type HijackOutcome,
  parseHijackEvent,
  publicAttemptText,
  reduceAttempt,
} from '../lib/hijack-view';

const step = (text: string): StepEntry => ({
  turn: 1,
  role: 'assistant',
  text,
  at: '2026-10-28T10:00:00.000Z',
});

const outcome: HijackOutcome = {
  status: 'done',
  followed: true,
  proposals: [
    {
      product: 'Digital gift card $189',
      store: 'GiftVault',
      amountCents: 18900,
      decision: 'blocked',
      reason: "GiftVault isn't in your stores. No PayPal order created.",
      attacker: true,
    },
  ],
  attackerCents: 0,
  model: 'openai/gpt-oss-20b',
};

describe('parseHijackEvent', () => {
  it('reads steps, results and replays, and drops anything malformed', () => {
    const entry = step('hi');
    expect(parseHijackEvent('agent.step', JSON.stringify({ sessionId: 's', entry }))).toEqual({
      type: 'agent.step',
      entry,
    });
    expect(parseHijackEvent('hijack.result', JSON.stringify({ sessionId: 's', outcome }))).toEqual({
      type: 'hijack.result',
      outcome,
    });
    expect(parseHijackEvent('hijack.result', '{"outcome":{"status":"won"}}')).toBeNull();
    expect(parseHijackEvent('approval.created', '{}')).toBeNull();
    expect(parseHijackEvent('agent.step', 'not json')).toBeNull();
  });
});

describe('reduceAttempt', () => {
  it('shows live steps until a replay starts, then only replayed steps', () => {
    let s = reduceAttempt(EMPTY_ATTEMPT, { type: 'agent.step', entry: step('live 1') });
    s = reduceAttempt(s, { type: 'hijack.step', entry: step('ignored before replay') });
    expect(s.steps.map((x) => x.text)).toEqual(['live 1']);
    s = reduceAttempt(s, { type: 'hijack.replay', reason: 'slow' });
    expect(s).toMatchObject({ replay: true, replayReason: 'slow', steps: [] });
    s = reduceAttempt(s, { type: 'agent.step', entry: step('late live step') });
    s = reduceAttempt(s, { type: 'hijack.step', entry: step('recorded 1') });
    expect(s.steps.map((x) => x.text)).toEqual(['recorded 1']);
  });

  it('keeps the first result', () => {
    let s = reduceAttempt(EMPTY_ATTEMPT, { type: 'hijack.result', outcome });
    s = reduceAttempt(s, {
      type: 'hijack.result',
      outcome: { ...outcome, followed: false },
    });
    expect(s.outcome?.followed).toBe(true);
  });
});

describe('result lines', () => {
  it('says whether the agent followed and what reached an attacker', () => {
    expect(followedLine(outcome)).toBe('The agent followed your text: yes');
    expect(followedLine({ ...outcome, followed: false })).toBe('The agent followed your text: no');
    expect(attackerLine(outcome)).toBe('Money moved to an attacker: $0.00');
  });
});

describe('publicAttemptText', () => {
  it('removes emails and long numbers and shortens', () => {
    expect(publicAttemptText('mail me at a.b@example.com or +1 (415) 555-0100 now')).toBe(
      'mail me at [email] or [number] now',
    );
    expect(publicAttemptText('x'.repeat(300))).toHaveLength(240);
    expect(publicAttemptText('Buy the $189 card')).toBe('Buy the $189 card');
  });
});
