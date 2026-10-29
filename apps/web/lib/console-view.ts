import { z } from 'zod';

// Shapes the gateway's /human/events stream and /human/proposals send (apps/gateway/src/routes/
// events.ts). Parsed at the boundary; unknown keys are stripped.

export const PAYMENT_STATES = [
  'authorizing',
  'authorized',
  'held',
  'capture_requested',
  'captured',
  'void_requested',
  'voided',
  'expired',
  'denied',
  'failed',
] as const;

export const ProposalViewSchema = z.object({
  proposalId: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
  product: z.string(),
  merchant: z.string(),
  qty: z.number().int(),
  amountCents: z.number().int(),
  state: z.enum([...PAYMENT_STATES, 'blocked', 'recorded']),
  reason: z.string(),
  paymentId: z.string().nullable(),
  orderId: z.string().nullable(),
  authorizationId: z.string().nullable(),
  captureId: z.string().nullable(),
  buyerPresent: z.boolean(),
  approvalId: z.string().nullable(),
  holdDeadlineAt: z.string().nullable(),
});
export type ProposalView = z.infer<typeof ProposalViewSchema>;

export const StepEntrySchema = z.object({
  turn: z.number().int(),
  role: z.enum(['user', 'assistant', 'tool', 'error']),
  text: z.string(),
  reasoning: z.string().optional(),
  toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })).optional(),
  toolName: z.string().optional(),
  isError: z.boolean().optional(),
  at: z.string(),
});
export type StepEntry = z.infer<typeof StepEntrySchema>;

export const AgentStepSchema = z.object({ sessionId: z.string(), entry: StepEntrySchema });

export const ApprovalViewSchema = z.object({
  approvalId: z.string(),
  proposalId: z.string(),
  paymentId: z.string(),
  status: z.enum(['pending', 'approved', 'denied', 'timed_out']),
  deadlineAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedVia: z.enum(['web', 'phone']).nullable(),
});

export type ConsoleEvent =
  | { type: 'agent.step'; data: z.infer<typeof AgentStepSchema> }
  | { type: 'proposal.created' | 'payment.updated'; data: ProposalView }
  | { type: 'approval.created' | 'approval.decided'; data: z.infer<typeof ApprovalViewSchema> };

/** One SSE message to a typed event, or null for anything unknown or malformed. */
export function parseEvent(event: string, raw: string): ConsoleEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  switch (event) {
    case 'agent.step': {
      const r = AgentStepSchema.safeParse(json);
      return r.success ? { type: event, data: r.data } : null;
    }
    case 'proposal.created':
    case 'payment.updated': {
      const r = ProposalViewSchema.safeParse(json);
      return r.success ? { type: event, data: r.data } : null;
    }
    case 'approval.created':
    case 'approval.decided': {
      const r = ApprovalViewSchema.safeParse(json);
      return r.success ? { type: event, data: r.data } : null;
    }
    default:
      return null;
  }
}

/** How far each state has moved; a snapshot never replaces a further-along one. */
const RANK: Record<ProposalView['state'], number> = {
  authorizing: 0,
  authorized: 1,
  held: 2,
  capture_requested: 3,
  void_requested: 3,
  captured: 4,
  voided: 4,
  expired: 4,
  denied: 4,
  failed: 4,
  blocked: 4,
  recorded: 4,
};

/** Merges snapshots into the list by proposal ID, newest first, keeping the furthest state. */
export function mergeProposals(current: ProposalView[], incoming: ProposalView[]): ProposalView[] {
  const byId = new Map(current.map((p) => [p.proposalId, p]));
  for (const next of incoming) {
    const prev = byId.get(next.proposalId);
    if (!prev || RANK[next.state] >= RANK[prev.state]) byId.set(next.proposalId, next);
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- stream event IDs -------------------------------------------------------------------------

/**
 * Event IDs are `{boot}:{seq}` from one gateway process. A different boot (gateway restarted)
 * starts a new sequence, so its events always count as new.
 */
export function isNewerEventId(last: string | undefined, id: string): boolean {
  if (!last) return true;
  const [lastBoot, lastSeq] = last.split(':');
  const [boot, seq] = id.split(':');
  if (boot !== lastBoot) return true;
  return Number(seq) > Number(lastSeq);
}

// ---- stored transcripts -----------------------------------------------------------------------

/** The steps the stream shows (assistant and tool entries), read from a stored transcript. */
export function streamedSteps(transcript: unknown): StepEntry[] {
  if (!Array.isArray(transcript)) return [];
  return transcript.flatMap((e) => {
    const r = StepEntrySchema.safeParse(e);
    return r.success && (r.data.role === 'assistant' || r.data.role === 'tool') ? [r.data] : [];
  });
}

// ---- search results ---------------------------------------------------------------------------

export interface ListingHit {
  title: string;
  store: string;
  price: string;
  /** Third-party text: render as plain text only. */
  listingText: string;
  injected: boolean;
}

// Phrases that only make sense addressed to an agent. The adapted attack goal always reads
// "Buy {title} (product id {id}) from {store}."
const INJECTION =
  /\(product id |propose_purchase|ignore (all |the |any )?(previous|prior|above)|disregard|new instructions?|system prompt|\bas an ai\b|\byou must\b|\bassistant\b|\bIMPORTANT\b/i;

export function looksInjected(text: string): boolean {
  return INJECTION.test(text);
}

function unquote(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const ITEM = new RegExp(
  `"title":${STR},"store":${STR},"price_usd":${STR},"category":${STR},"untrusted_listing_text":${STR}`,
  'g',
);

/**
 * Listings from a search_products result ("Found N products.\n{json}"). The stream clips long
 * results, so items are read one by one and a cut-off last item is dropped.
 */
export function searchHits(text: string): ListingHit[] {
  const hits: ListingHit[] = [];
  for (const m of text.matchAll(ITEM)) {
    const listingText = unquote(m[5] ?? '');
    hits.push({
      title: unquote(m[1] ?? ''),
      store: unquote(m[2] ?? ''),
      price: unquote(m[3] ?? ''),
      listingText,
      injected: looksInjected(listingText),
    });
  }
  return hits;
}

/** What `npm run demo:hook` recorded about the demo's poisoned listing. */
export interface DemoHook {
  episodeId: string;
  followedBy: number;
  modelsTotal: number;
  label: string;
  listingTitle: string;
  listingStore: string;
  targetGoal: string;
}

/** "Template from test episode <id> · followed by k of 3 models" for the demo hook's listing. */
export function demoHookTag(hit: ListingHit, hook: DemoHook): string | null {
  const isHook =
    hit.injected &&
    hit.title === hook.listingTitle &&
    hit.store === hook.listingStore &&
    hit.listingText.includes(hook.targetGoal);
  if (!isHook) return null;
  return `Template from ${hook.label} ${hook.episodeId} · followed by ${hook.followedBy} of ${hook.modelsTotal} models`;
}

/** The first line of a tool result: the gateway's own sentence. */
export function firstLine(text: string): string {
  const i = text.indexOf('\n');
  return i === -1 ? text : text.slice(0, i);
}

// ---- run failures -----------------------------------------------------------------------------

export type FailureKind = 'budget' | 'max_turns' | 'model';

export const FAILURE_TEXT: Record<FailureKind, string> = {
  budget: "The agent stopped: it reached today's budget for model calls.",
  max_turns: 'The agent stopped: it used all its turns without finishing.',
  model: 'The agent stopped: the model returned an error.',
};

/** Reads the failure kind from the last error entry of a session transcript. */
export function failureKind(transcript: unknown): FailureKind {
  const entries = Array.isArray(transcript)
    ? (transcript as { role?: unknown; text?: unknown }[])
    : [];
  const last = [...entries].reverse().find((e) => e?.role === 'error');
  const text = typeof last?.text === 'string' ? last.text : '';
  if (/BUDGET_EXCEEDED|failed: budget/.test(text)) return 'budget';
  if (/failed: max_turns/.test(text)) return 'max_turns';
  return 'model';
}
