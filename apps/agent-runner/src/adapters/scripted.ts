import { readFileSync } from 'node:fs';
import { AppError, ErrorCode } from '@twokey/core';
import { z } from 'zod';
import type { ModelAdapter, Msg } from './types.js';

const SCRIPTS_DIR = new URL('../../scripts/', import.meta.url);

/** A product_id the script looks up in the latest search result, never a literal ID. */
const Listing = z.object({
  $listing: z.object({ store: z.string().min(1), title: z.string().min(1) }),
});

const Script = z.object({
  turns: z.array(
    z.object({
      text: z.string().default(''),
      toolCalls: z
        .array(
          z.object({
            name: z.string().min(1),
            input: z.record(z.string(), z.unknown()).default({}),
          }),
        )
        .default([]),
    }),
  ),
});
type Script = z.infer<typeof Script>;

export interface ScriptedConfig {
  NODE_ENV?: 'development' | 'test' | 'production' | undefined;
  ALLOW_SCRIPTED?: string | undefined;
}

function loadScript(name: string): Script {
  // The name becomes a file name: letters, digits and dashes only.
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new AppError(ErrorCode.CONFIG_INVALID, `Unknown script "${name}"`);
  }
  let raw: string;
  try {
    raw = readFileSync(new URL(`${name}.json`, SCRIPTS_DIR), 'utf8');
  } catch {
    throw new AppError(ErrorCode.CONFIG_INVALID, `Unknown script "${name}"`);
  }
  const parsed = Script.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new AppError(ErrorCode.CONFIG_INVALID, `Script "${name}" is not valid`);
  }
  return parsed.data;
}

/** The items of the most recent search_products result in the conversation. */
function lastSearchItems(messages: Msg[]): { product_id: string; title: string; store: string }[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'tool' || !m.toolResult) continue;
    const start = m.toolResult.indexOf('{');
    if (start === -1) continue;
    try {
      const body = JSON.parse(m.toolResult.slice(start)) as { items?: unknown };
      if (Array.isArray(body.items)) return body.items as never;
    } catch {
      // Not a search result; keep looking.
    }
  }
  return [];
}

function resolveInput(input: Record<string, unknown>, messages: Msg[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const ref = Listing.safeParse(value);
    if (!ref.success) {
      out[key] = value;
      continue;
    }
    const { store, title } = ref.data.$listing;
    const hit = lastSearchItems(messages).find(
      (item) => item.store === store && item.title.includes(title),
    );
    if (!hit) {
      throw new AppError(ErrorCode.INTERNAL, `Scripted run found no "${title}" at ${store}`);
    }
    out[key] = hit.product_id;
  }
  return out;
}

const usage = () => ({ inputTokens: 0, outputTokens: 0 });

/**
 * Deterministic stand-in for a model: turn N of the script is the Nth step. Refused in
 * production unless ALLOW_SCRIPTED=true.
 */
export function createScriptedAdapter(model: string, cfg: ScriptedConfig): ModelAdapter {
  if (cfg.NODE_ENV === 'production' && cfg.ALLOW_SCRIPTED !== 'true') {
    throw new AppError(ErrorCode.CONFIG_INVALID, 'Scripted models are not allowed in production');
  }
  const script = loadScript(model.slice('scripted:'.length));
  return {
    id: model,
    async step(i) {
      const turn = i.messages.filter((m) => m.role === 'assistant').length;
      const spec = script.turns[turn];
      if (!spec) return { text: '', toolCalls: [], stop: 'end', usage: usage() };
      const toolCalls = spec.toolCalls.map((c, n) => ({
        id: `scripted-${turn}-${n}`,
        name: c.name,
        input: resolveInput(c.input, i.messages),
      }));
      return {
        text: spec.text,
        toolCalls,
        stop: toolCalls.length > 0 ? 'tool' : 'end',
        usage: usage(),
      };
    },
  };
}
