'use server';

import { AppError, type CompilerOutput, ErrorCode, toDraftCard } from '@twokey/core';
import { agentSessions, ruleCards } from '@twokey/db';
import { and, eq, max, ne } from 'drizzle-orm';
import { refresh } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/lib/db';
import { webEnv } from '@/lib/env';
import { gatewayFetch } from '@/lib/gateway';
import {
  CANCELLED_MESSAGE,
  checkReturn,
  EXTERNAL_MODEL,
  type Failure,
  MISMATCH_MESSAGE,
  SAVED_COOKIE_MAX_AGE_S,
  SETUP_COOKIE,
  SETUP_COOKIE_MAX_AGE_S,
  setupCookieValue,
  toFailure,
} from '@/lib/onboarding';
import { loadRegistry } from '@/lib/registry';
import type { DraftView } from '@/lib/rules-view';
import { requireUser } from '@/lib/session';

export type ActionState<T = undefined> =
  | { status: 'idle' }
  | { status: 'error'; failure: Failure }
  | { status: 'ok'; data: T };

const fail = (failure: Failure) => ({ status: 'error' as const, failure });

// ---- step 1: PayPal --------------------------------------------------------------------------

const SETUP_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'lax', // PayPal's return is a top-level GET navigation
  secure: process.env.NODE_ENV === 'production',
  path: '/onboarding/paypal',
} as const;

/** Creates a setup token bound to this user's browser, then sends them to PayPal to approve it. */
export async function startPayPalConnect(_prev: ActionState): Promise<ActionState> {
  const user = await requireUser();
  let approveUrl: string;
  try {
    const returnUrl = new URL('/onboarding/paypal/return', webEnv().WEB_ORIGIN).toString();
    const res = await gatewayFetch<{ setupTokenId: string; approveUrl: string }>(
      '/human/vault/setup-token',
      { method: 'POST', body: { returnUrl }, scope: 'vault:manage' },
    );
    (await cookies()).set(SETUP_COOKIE, setupCookieValue(user.userId, res.setupTokenId), {
      ...SETUP_COOKIE_OPTIONS,
      maxAge: SETUP_COOKIE_MAX_AGE_S,
    });
    approveUrl = res.approveUrl;
  } catch (err) {
    return fail(toFailure(err, 'paypal'));
  }
  redirect(approveUrl);
}

/** Turns the approved setup token into a saved wallet, only if it is the one made for this session. */
export async function completePayPalConnect(query: {
  approval_token_id?: string;
  token?: string;
  setup_token_id?: string;
}): Promise<ActionState> {
  const user = await requireUser();
  const jar = await cookies();
  const check = checkReturn({ query, cookie: jar.get(SETUP_COOKIE)?.value, userId: user.userId });
  // Already saved from this browser (a reload or a second tab): same answer, no second call.
  if (check.kind === 'saved') return { status: 'ok', data: undefined };
  if (check.kind === 'cancelled') {
    return fail({
      message: CANCELLED_MESSAGE,
      next: { label: 'Connect PayPal', href: '/onboarding/paypal' },
    });
  }
  if (check.kind !== 'ok') {
    return fail({
      message: MISMATCH_MESSAGE,
      next: { label: 'Start again', href: '/onboarding/paypal' },
    });
  }
  try {
    await gatewayFetch('/human/vault/payment-token', {
      method: 'POST',
      body: { setupTokenId: check.setupTokenId },
      scope: 'vault:manage',
    });
  } catch (err) {
    return fail(toFailure(err, 'paypal'));
  }
  // Keep a "saved" marker so revisiting this return URL shows "Saved", never an error.
  jar.set(SETUP_COOKIE, setupCookieValue(user.userId, check.setupTokenId, true), {
    ...SETUP_COOKIE_OPTIONS,
    maxAge: SAVED_COOKIE_MAX_AGE_S,
  });
  refresh(); // the setup header marks step 1 done
  return { status: 'ok', data: undefined };
}

// ---- step 2: rules ---------------------------------------------------------------------------

const Manual = z.object({
  stores: z.array(z.string().min(1).max(60)).max(20),
  perItemCapUsd: z.coerce.number().positive().max(100_000).nullable(),
  perOrderCapUsd: z.coerce.number().positive().max(100_000).nullable(),
  maxQty: z.coerce.number().int().min(1).max(20),
  maxPurchases: z.coerce.number().int().min(1).max(50),
  windowHours: z.coerce.number().int().min(1).max(720),
  expiresOn: z.iso.date(),
});

const DAY_MS = 86_400_000;

function optionalNumber(value: FormDataEntryValue | null): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The manual fallback when the AI compiler is down: same fields, same deterministic draft. */
export async function saveManualDraft(
  _prev: ActionState<DraftView>,
  form: FormData,
): Promise<ActionState<DraftView>> {
  const user = await requireUser();
  const parsed = Manual.safeParse({
    stores: form.getAll('stores').filter((v) => typeof v === 'string'),
    perItemCapUsd: optionalNumber(form.get('perItemCapUsd')),
    perOrderCapUsd: optionalNumber(form.get('perOrderCapUsd')),
    maxQty: form.get('maxQty'),
    maxPurchases: form.get('maxPurchases'),
    windowHours: form.get('windowHours'),
    expiresOn: form.get('expiresOn'),
  });
  if (!parsed.success) {
    return fail({
      message: 'Check the highlighted fields: caps in dollars, a quantity and an end date.',
      next: { label: 'Fix and try again' },
    });
  }
  const m = parsed.data;
  const now = new Date();
  const end = new Date(`${m.expiresOn}T23:59:59Z`);
  const days = Math.ceil((end.getTime() - now.getTime()) / DAY_MS);
  if (days < 1) {
    return fail({ message: 'Pick an end date after today.', next: { label: 'Fix and try again' } });
  }

  try {
    const registry = await loadRegistry();
    const output: CompilerOutput = {
      perItemCapUsd: m.perItemCapUsd,
      perOrderCapUsd: m.perOrderCapUsd,
      stores: m.stores,
      categories: null,
      maxQty: m.maxQty,
      frequency: { maxPurchases: m.maxPurchases, windowHours: m.windowHours },
      expiresInDays: days,
      advisory: [],
      unclear: [],
    };
    const [prev] = await db()
      .select({ version: max(ruleCards.version) })
      .from(ruleCards)
      .where(eq(ruleCards.userId, user.userId));
    const version = (prev?.version ?? 0) + 1;
    const draft = toDraftCard(output, {
      userId: user.userId,
      registry,
      now,
      version,
      defaults: {
        frequency: { maxPurchases: 5, windowHours: 24 },
        holdTimeoutMinutes: user.role === 'judge_demo' ? 15 : 1440,
        expiresInDays: 30,
      },
    });
    let draftId: string | null = null;
    if (draft.card) {
      const [row] = await db()
        .insert(ruleCards)
        .values({
          userId: user.userId,
          version,
          status: 'draft',
          nlRequest: '(entered by hand)',
          rules: draft.card,
          enforcement: draft.enforcement,
          compilerModel: null,
        })
        .returning({ id: ruleCards.id });
      draftId = row?.id ?? null;
      if (!draftId) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
    }
    return { status: 'ok', data: { draftId, ...draft } };
  } catch (err) {
    return fail(toFailure(err, 'rules'));
  }
}

const DraftId = z.uuid();

/** "Confirm & sign": the gateway signs the stored draft; nothing from the browser is signed. */
export async function signRules(draftId: string): Promise<ActionState> {
  await requireUser();
  const id = DraftId.safeParse(draftId);
  if (!id.success) return fail(toFailure(new AppError(ErrorCode.NOT_FOUND, 'x'), 'rules'));
  try {
    await gatewayFetch(`/human/rules/${id.data}/sign`, { method: 'POST', scope: 'rules:sign' });
  } catch (err) {
    return fail(toFailure(err, 'rules'));
  }
  refresh(); // the shared /rules layout's header marks step 2 done
  redirect(`/rules/${id.data}`);
}

// ---- step 3: agent ---------------------------------------------------------------------------

/** Mints an agent token for the user's own MCP client. Returned once; only its hash is stored. */
export async function createAgentToken(
  _prev: ActionState<{ token: string; mcpUrl: string }>,
  form?: FormData,
): Promise<ActionState<{ token: string; mcpUrl: string }>> {
  const user = await requireUser();
  // Demo unless live is asked for: live search finds nothing purchasable in the sandbox.
  const mode = form?.get('mode') === 'live' ? 'live' : 'demo';
  try {
    // A new token replaces the old one: end earlier external sessions so only one works.
    const res = await gatewayFetch<{ sessionId: string; token: string }>('/human/sessions', {
      method: 'POST',
      body: { mode, model: EXTERNAL_MODEL },
      scope: 'sessions:create',
    });
    await db()
      .update(agentSessions)
      .set({ status: 'ended', endedAt: new Date() })
      .where(
        and(
          eq(agentSessions.userId, user.userId),
          eq(agentSessions.model, EXTERNAL_MODEL),
          eq(agentSessions.status, 'active'),
          // keep the one just created
          ne(agentSessions.id, res.sessionId),
        ),
      );
    return { status: 'ok', data: { token: res.token, mcpUrl: webEnv().MCP_PUBLIC_URL } };
  } catch (err) {
    return fail(toFailure(err, 'agent'));
  }
}
