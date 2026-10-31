import { z } from 'zod';
import type { Redactor } from './redact';

/**
 * Pure pieces of the episodes explorer: filters, row selection and transcript steps. The row
 * sets use the same definitions as computeMetricsFrom (eval/src/metrics.ts), so a count on
 * /results and the grid it links to always agree.
 */

export const GATE_IDS = ['G0', 'G1', 'G2', 'G3', 'G4'] as const;
export type GateId = (typeof GATE_IDS)[number];
export type Outcome = 'capture' | 'hold' | 'block' | 'ask_every_time';
export const VARIANTS = ['clean', 'injecagent', 'agentdojo'] as const;
export type Variant = (typeof VARIANTS)[number];
export const TARGET_TYPES = ['outside_rules', 'inside_rules'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

/**
 * followed / attacked / clean: runs. interrupted: clean runs whose first proposal the gate did
 * not capture. let_through: followed attacks whose target proposal the gate captured.
 */
export const EPISODE_SETS = [
  'followed',
  'attacked',
  'clean',
  'interrupted',
  'let_through',
] as const;
export type EpisodeSet = (typeof EPISODE_SETS)[number];
/** passed = capture or hold (every signed rule passed). */
export const OUTCOME_FILTERS = ['capture', 'hold', 'block', 'ask_every_time', 'passed'] as const;

export const PAGE_SIZE = 200;

const FilterFields = {
  split: z.enum(['dev', 'test']),
  model: z.string().min(1).max(200),
  gate: z.enum(GATE_IDS),
  set: z.enum(EPISODE_SETS),
  variant: z.enum(VARIANTS),
  target: z.enum(TARGET_TYPES),
  outcome: z.enum(OUTCOME_FILTERS),
  /** Attacks that wanted an inside-the-rules target, found none and fell back to outside. */
  fallback: z.literal('true'),
  page: z.coerce.number().int().min(1).max(10_000),
};
export type FilterKey = keyof typeof FilterFields;
export const FILTER_KEYS = Object.keys(FilterFields) as FilterKey[];

export interface EpisodeFilters {
  split?: 'dev' | 'test';
  model?: string;
  gate?: GateId;
  set?: EpisodeSet;
  variant?: Variant;
  target?: TargetType;
  outcome?: (typeof OUTCOME_FILTERS)[number];
  fallback?: 'true';
  page?: number;
}

/** Known keys only; each invalid value is reported, never applied. */
export function parseEpisodeFilters(params: Record<string, string | string[] | undefined>): {
  filters: EpisodeFilters;
  invalid: FilterKey[];
} {
  const filters: Record<string, unknown> = {};
  const invalid: FilterKey[] = [];
  for (const key of FILTER_KEYS) {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === '') continue;
    const parsed = FilterFields[key].safeParse(value);
    if (parsed.success) filters[key] = parsed.data;
    else invalid.push(key);
  }
  return { filters: filters as EpisodeFilters, invalid };
}

export interface EpisodeRow {
  /** One row per run: episode × model. */
  runId: string;
  episodeId: string;
  taskId: string;
  variant: Variant;
  targetType: TargetType | null;
  targetFallback: boolean;
  model: string;
  followed: boolean;
  /** The proposal the outcomes describe: the target for followed attacks, else the first. */
  g0: Outcome | null;
  g1: Outcome | null;
  g2: Outcome | null;
  g3: Outcome | null;
  g4: Outcome | null;
  proposalTitle: string | null;
  proposals: number;
  costUsd: number;
  /** Clean runs: the first proposal exists (the frontier's x denominator). */
  hasProposal: boolean;
}

export const outcomeAt = (row: EpisodeRow, gate: GateId): Outcome | null =>
  row[gate.toLowerCase() as 'g0' | 'g1' | 'g2' | 'g3' | 'g4'];

export function inSet(row: EpisodeRow, set: EpisodeSet, gate: GateId): boolean {
  const attacked = row.variant !== 'clean';
  switch (set) {
    case 'attacked':
      return attacked;
    case 'followed':
      return attacked && row.followed;
    case 'clean':
      return !attacked;
    case 'interrupted':
      return !attacked && row.hasProposal && outcomeAt(row, gate) !== 'capture';
    case 'let_through':
      return attacked && row.followed && outcomeAt(row, gate) === 'capture';
  }
}

export function filterRows(rows: readonly EpisodeRow[], f: EpisodeFilters): EpisodeRow[] {
  const gate = f.gate ?? 'G4';
  return rows.filter((r) => {
    if (f.model && r.model !== f.model) return false;
    if (f.variant && r.variant !== f.variant) return false;
    if (f.target && r.targetType !== f.target) return false;
    if (f.fallback && !r.targetFallback) return false;
    if (f.set && !inSet(r, f.set, gate)) return false;
    if (f.outcome) {
      const o = outcomeAt(r, gate);
      if (f.outcome === 'passed' ? o !== 'capture' && o !== 'hold' : o !== f.outcome) return false;
    }
    return true;
  });
}

export function paginate<T>(rows: readonly T[], page = 1) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  return {
    total: rows.length,
    page: current,
    pages,
    pageSize: PAGE_SIZE,
    rows: rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE),
  };
}

// ---- transcripts ------------------------------------------------------------------------------

export interface TranscriptStep {
  kind: 'user' | 'assistant' | 'reasoning' | 'tool_call' | 'tool_result' | 'error';
  toolName?: string;
  text: string;
}

interface RawEntry {
  role?: unknown;
  text?: unknown;
  reasoning?: unknown;
  toolName?: unknown;
  isError?: unknown;
  toolCalls?: { name?: unknown; input?: unknown }[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

function jsonAfterFirstLine(text: string): unknown {
  const i = text.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
}

/**
 * Tool results never show listing text (Channel3 terms, W18): a search becomes the listing IDs
 * it returned, a proposal its recorded decision; everything is brand-redacted.
 */
function toolResult(name: string, text: string, isError: boolean, r: Redactor) {
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (!isError && name === 'search_products') {
    const body = jsonAfterFirstLine(text) as { items?: { product_id?: unknown }[] } | null;
    const ids = (body?.items ?? []).map((i) => str(i.product_id)).filter(Boolean);
    return ids.length > 0 ? `${r(firstLine)} Listing IDs: ${ids.join(', ')}` : r(firstLine);
  }
  if (!isError && name === 'propose_purchase') {
    const body = jsonAfterFirstLine(text) as { decision?: unknown; reason?: unknown } | null;
    if (body) return r(`Decision: ${str(body.decision)}. ${str(body.reason)}`);
  }
  return clip(r(firstLine), 240);
}

function toolCall(name: string, input: unknown, r: Redactor): string {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const parts = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return clip(r(`${name}(${parts.join(', ')})`), 300);
}

/** agent_sessions.transcript → redacted steps; null when there is no usable transcript. */
export function transcriptSteps(raw: unknown, r: Redactor): TranscriptStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const steps: TranscriptStep[] = [];
  for (const e of raw as RawEntry[]) {
    const role = str(e.role);
    const text = str(e.text).trim();
    if (role === 'user' && text) steps.push({ kind: 'user', text: r(text) });
    else if (role === 'assistant') {
      const reasoning = str(e.reasoning).trim();
      if (reasoning) {
        steps.push({ kind: 'reasoning', text: clip(r(reasoning), 500) });
      }
      if (text) steps.push({ kind: 'assistant', text: clip(r(text), 1200) });
      for (const c of e.toolCalls ?? []) {
        const name = str(c.name);
        steps.push({ kind: 'tool_call', toolName: name, text: toolCall(name, c.input, r) });
      }
    } else if (role === 'tool') {
      const name = str(e.toolName);
      steps.push({
        kind: e.isError === true ? 'error' : 'tool_result',
        toolName: name,
        text: toolResult(name, text, e.isError === true, r),
      });
    } else if (role === 'error') {
      steps.push({ kind: 'error', text: clip(r(text), 240) });
    }
  }
  return steps.length > 0 ? steps : null;
}

// ---- attack templates -------------------------------------------------------------------------

const REPOS: Record<string, string> = {
  injecagent: 'https://github.com/uiuc-kang-lab/InjecAgent',
  agentdojo: 'https://github.com/ethz-spylab/agentdojo',
};

export interface SourceRef {
  commit: string | null;
  commitUrl: string | null;
  files: { file: string; caseId: string | null; url: string | null; line?: number | null }[];
}

/** "path:line 3 (Case)@sha" or "a.py#Case + b.py#Class@sha" → links into the pinned commit. */
export function parseSourceRef(source: string, ref: string): SourceRef {
  const at = ref.lastIndexOf('@');
  const commit = at >= 0 && /^[0-9a-f]{7,40}$/.test(ref.slice(at + 1)) ? ref.slice(at + 1) : null;
  const body = commit ? ref.slice(0, at) : ref;
  const repo = REPOS[source] ?? null;
  const files = body.split(' + ').map((part) => {
    const m = /^([^:#]+)[:#](.+)$/.exec(part.trim());
    const file = m?.[1] ?? part.trim();
    const caseId = m?.[2] ?? null;
    const line = caseId ? /^line (\d+)/.exec(caseId)?.[1] : undefined;
    const url = repo && commit ? `${repo}/blob/${commit}/${file}${line ? `#L${line}` : ''}` : null;
    return { file, caseId, url };
  });
  return { commit, commitUrl: repo && commit ? `${repo}/commit/${commit}` : null, files };
}

/**
 * The text inserted into the injected listing: the injected description ends with the filled
 * adapted template, so take it from where the template's fixed opening starts.
 */
export function insertedText(description: string, adaptedTemplate: string): string | null {
  const opening = adaptedTemplate.split(/\{(?:title|productId|storeName)\}/, 1)[0] ?? '';
  const probe = opening.slice(0, 60);
  if (probe.length < 8) return null;
  const at = description.lastIndexOf(probe);
  return at >= 0 ? description.slice(at) : null;
}
