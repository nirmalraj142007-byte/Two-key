import { z } from 'zod';
import { type ConsoleEvent, parseEvent } from './console-view';

// The console's replay fallback: public/golden-run.json, recorded by `npm run demo:record-golden`
// (scripted models, local stack, IDs prefixed REPLAY-). Played through the same components as a
// live run, always under the replay banner. Never presented as live.

export const GOLDEN_RUN_PATH = '/golden-run.json';
export const REPLAY_FALLBACK_TEXT =
  'Replaying a recorded run — PayPal sandbox or the model is unavailable right now';

/** Pause between beats, and the longest wait shown between two events of one beat. */
export const BEAT_GAP_MS = 2500;
export const MAX_EVENT_GAP_MS = 4000;

const RecordedEvent = z.object({
  t: z.number().nonnegative(),
  event: z.string(),
  data: z.unknown(),
});

export const GoldenRunSchema = z.object({
  recordedAt: z.string(),
  beats: z.array(
    z.object({
      name: z.string(),
      model: z.string(),
      message: z.string(),
      startedAt: z.string(),
      events: z.array(RecordedEvent),
    }),
  ),
});
export type GoldenRun = z.infer<typeof GoldenRunSchema>;

export interface TimedEvent {
  /** Milliseconds after playback starts. */
  at: number;
  beat: number;
  message: string;
  /** Session the beat ran in (a REPLAY- alias). */
  sessionId: string | null;
  event: ConsoleEvent;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Moves every ISO timestamp in `value` by `offsetMs`, so a replay reads as "just now". */
export function rebase<T>(value: T, offsetMs: number): T {
  if (typeof value === 'string') {
    return (ISO.test(value) ? new Date(Date.parse(value) + offsetMs).toISOString() : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => rebase(v, offsetMs)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v, offsetMs)])) as T;
  }
  return value;
}

/**
 * One timeline for the whole file: beats in order, BEAT_GAP_MS apart, long waits inside a beat
 * (the hold before the deny) shortened to MAX_EVENT_GAP_MS. Unknown or malformed events are
 * dropped by the same parser the live stream uses. Timestamps are rebased onto `startedAt`.
 */
export function replayTimeline(run: GoldenRun, startedAt: Date): TimedEvent[] {
  const out: TimedEvent[] = [];
  const offset = startedAt.getTime() - Date.parse(run.recordedAt);
  let clock = 0;
  run.beats.forEach((beat, i) => {
    if (i > 0) clock += BEAT_GAP_MS;
    let last = 0;
    for (const rec of beat.events) {
      clock += Math.min(MAX_EVENT_GAP_MS, Math.max(0, rec.t - last));
      last = rec.t;
      const event = parseEvent(rec.event, JSON.stringify(rebase(rec.data, offset)));
      if (!event) continue;
      const sessionId =
        'sessionId' in event.data && typeof event.data.sessionId === 'string'
          ? event.data.sessionId
          : null;
      out.push({ at: clock, beat: i, message: beat.message, sessionId, event });
    }
  });
  return out;
}

/** Why the console shows the recording instead of a live run, or null for a live console. */
export type FallbackReason = 'forced' | 'paypal' | 'agent';

export function fallbackReason(opts: {
  demoFallback: string | undefined;
  paypalDegraded: boolean;
}): FallbackReason | null {
  if (opts.demoFallback === 'replay') return 'forced';
  if (opts.paypalDegraded) return 'paypal';
  return null;
}
