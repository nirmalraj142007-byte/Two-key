import { HijackOutcome } from '@twokey/core/hijack';
import { formatUSD } from '@twokey/core/money';
import { z } from 'zod';
import { type StepEntry, StepEntrySchema } from './console-view';

// Shapes of the public hijack stream (gateway routes/hijack.ts) and of GET /api/hijack/[id].
// Parsed at the boundary; unknown keys are stripped. Client-safe: no server imports.

export type { HijackOutcome };

export const AttemptViewSchema = z.object({
  status: z.enum(['running', 'done', 'replayed', 'failed']),
  replay: z.boolean(),
  createdAt: z.string(),
  outcome: HijackOutcome.nullable(),
  steps: z.array(StepEntrySchema),
});
export type AttemptView = z.infer<typeof AttemptViewSchema>;

export const StartResponseSchema = z.object({
  attemptId: z.uuid(),
  attemptToken: z.string().min(1),
  mode: z.enum(['live', 'replay']),
});

export const StatusSchema = z.object({
  triesLeftThisHour: z.number().int(),
  attemptsLeftToday: z.number().int(),
  tokensLeftToday: z.number().int(),
  live: z.boolean(),
});
export type HijackStatus = z.infer<typeof StatusSchema>;

const PublicProposal = z.object({
  proposalId: z.string(),
  sessionId: z.string(),
  product: z.string(),
  merchant: z.string(),
  qty: z.number().int(),
  amountCents: z.number().int(),
  state: z.string(),
  reason: z.string(),
});
export type PublicProposal = z.infer<typeof PublicProposal>;

const Step = z.object({ sessionId: z.string(), entry: StepEntrySchema });

export type HijackEvent =
  | { type: 'agent.step' | 'hijack.step'; entry: StepEntry }
  | { type: 'proposal'; proposal: PublicProposal }
  | { type: 'hijack.replay'; reason: string }
  | { type: 'hijack.result'; outcome: HijackOutcome };

/** One SSE message to a typed event, or null for anything unknown or malformed. */
export function parseHijackEvent(event: string, raw: string): HijackEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (event) {
    case 'agent.step':
    case 'hijack.step': {
      const r = Step.safeParse(json);
      return r.success ? { type: event, entry: r.data.entry } : null;
    }
    case 'proposal.created':
    case 'payment.updated': {
      const r = PublicProposal.safeParse(json);
      return r.success ? { type: 'proposal', proposal: r.data } : null;
    }
    case 'hijack.replay': {
      const r = z.object({ reason: z.string() }).safeParse(json);
      return r.success ? { type: 'hijack.replay', reason: r.data.reason } : null;
    }
    case 'hijack.result': {
      const r = z.object({ outcome: HijackOutcome }).safeParse(json);
      return r.success ? { type: 'hijack.result', outcome: r.data.outcome } : null;
    }
    default:
      return null;
  }
}

// ---- page state -------------------------------------------------------------------------------

export interface AttemptState {
  /** Steps shown: live ones, or (once a replay starts) only the replayed ones. */
  steps: StepEntry[];
  replay: boolean;
  replayReason: string | null;
  outcome: HijackOutcome | null;
}

export const EMPTY_ATTEMPT: AttemptState = {
  steps: [],
  replay: false,
  replayReason: null,
  outcome: null,
};

/**
 * Applies one event. A replay drops the live steps shown so far and ignores any live step after
 * it, so recorded and live steps never mix. The first result is final.
 */
export function reduceAttempt(s: AttemptState, e: HijackEvent): AttemptState {
  if (s.outcome) return s;
  switch (e.type) {
    case 'agent.step':
      return s.replay ? s : { ...s, steps: [...s.steps, e.entry] };
    case 'hijack.step':
      return s.replay ? { ...s, steps: [...s.steps, e.entry] } : s;
    case 'hijack.replay':
      // Replays chosen at submit time start with replay already set and no live steps.
      return { ...s, replay: true, replayReason: e.reason, steps: s.replay ? s.steps : [] };
    case 'hijack.result':
      return { ...s, outcome: e.outcome, replay: s.replay || e.outcome.status === 'replayed' };
    default:
      return s;
  }
}

/** The fallback poll's view, once the attempt has a result. */
export function fromView(v: AttemptView): AttemptState | null {
  if (!v.outcome) return null;
  return {
    steps: v.steps,
    replay: v.replay,
    replayReason: v.replay ? (v.outcome.message ?? null) : null,
    outcome: v.outcome,
  };
}

// ---- result card text --------------------------------------------------------------------------

export const DECISION_LABEL: Record<HijackOutcome['proposals'][number]['decision'], string> = {
  captured: 'Bought',
  held: 'Held for approval',
  blocked: 'Blocked',
  failed: 'Not purchased',
  recorded: 'Recorded',
};

export function followedLine(o: HijackOutcome): string {
  if (o.followed === null) return 'The agent followed your text: unknown';
  return `The agent followed your text: ${o.followed ? 'yes' : 'no'}`;
}

export function attackerLine(o: HijackOutcome): string {
  return `Money moved to an attacker: ${formatUSD(o.attackerCents)}`;
}

/** One line for the gate when the agent proposed nothing. */
export const NOTHING_PROPOSED =
  'The agent proposed nothing, so there was nothing for the gate to decide and no PayPal call.';

// ---- public dataset -----------------------------------------------------------------------------

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const LONG_NUMBER = /\+?\d[\d\s().-]{6,}\d/g;

/** Judge text for the public tab: emails and long numbers removed, then cut to `max`. */
export function publicAttemptText(text: string, max = 240): string {
  const scrubbed = text.replace(EMAIL, '[email]').replace(LONG_NUMBER, '[number]');
  return scrubbed.length > max ? `${scrubbed.slice(0, max - 1)}…` : scrubbed;
}
