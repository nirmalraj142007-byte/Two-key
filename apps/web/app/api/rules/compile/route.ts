import { AppError, ErrorCode, toHttp } from '@twokey/core';
import { ruleCards, spend } from '@twokey/db';
import { eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { auth } from '@/auth';
import { db } from '@/lib/db';
import { webEnv } from '@/lib/env';
import { createCompilerClient } from '@/lib/llm';
import { loadRegistry } from '@/lib/registry';
import { compileRules } from '@/lib/rule-compiler';

const Body = z.object({ request: z.string() });

function fail(err: unknown, requestId: string): Response {
  const { status, body } = toHttp(err, requestId);
  const llm = err instanceof AppError && err.code === ErrorCode.UPSTREAM_LLM;
  return Response.json(llm ? { ...body, fallback: 'manual' } : body, {
    status: llm ? 503 : status,
  });
}

export async function POST(req: Request): Promise<Response> {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  try {
    const session = await auth();
    if (!session?.userId) throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in first');
    const body = Body.safeParse(await req.json().catch(() => undefined));
    if (!body.success) throw new AppError(ErrorCode.VALIDATION, 'Body must be { request: string }');

    const env = webEnv();
    const registry = await loadRegistry();
    const [prev] = await db()
      .select({ version: max(ruleCards.version) })
      .from(ruleCards)
      .where(eq(ruleCards.userId, session.userId));
    const version = (prev?.version ?? 0) + 1;

    const result = await compileRules(body.data.request, registry, {
      client: await createCompilerClient(),
      now: new Date(),
      userId: session.userId,
      version,
      defaults: {
        frequency: { maxPurchases: 5, windowHours: 24 },
        holdTimeoutMinutes: session.role === 'judge_demo' ? 15 : 1440,
        expiresInDays: 30,
      },
      spend: (usd) => spend(db(), 'live', usd, env.DAILY_BUDGET_USD_LIVE),
    });

    let draftId: string | null = null;
    if (result.card) {
      const [row] = await db()
        .insert(ruleCards)
        .values({
          userId: session.userId,
          version,
          status: 'draft',
          nlRequest: body.data.request.trim(),
          rules: result.card,
          enforcement: result.enforcement,
          compilerModel: result.model,
        })
        .returning({ id: ruleCards.id });
      draftId = row?.id ?? null;
      if (!draftId) throw new AppError(ErrorCode.INTERNAL, 'Internal error');
    }
    return Response.json({
      draftId,
      card: result.card,
      enforcement: result.enforcement,
      advisory: result.advisory,
      warnings: result.warnings,
      needsInput: result.needsInput,
    });
  } catch (err) {
    return fail(err, requestId);
  }
}
