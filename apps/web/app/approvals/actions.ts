'use server';

import { AppError, ErrorCode } from '@twokey/core';
import { z } from 'zod';
import { type ApprovalItem, ApprovalItemSchema, type ApprovalState } from '@/lib/approvals-view';
import { gatewayFetch } from '@/lib/gateway';

const Id = z.uuid();
const Subscription = z.object({
  endpoint: z.url().max(2048),
  keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(64) }),
});

export type DecideResult = { ok: true; state: ApprovalState } | { ok: false; message: string };
export type PushResult = { ok: true } | { ok: false; message: string };

function sentence(message: string): string {
  return message.endsWith('.') ? message : `${message}.`;
}

/** Pending holds for the signed-in user, soonest deadline first. */
export async function pendingApprovals(): Promise<ApprovalItem[]> {
  const res = await gatewayFetch<{ items: unknown[] }>('/human/approvals?status=pending', {
    scope: 'approvals:decide',
  });
  return res.items.flatMap((i) => {
    const p = ApprovalItemSchema.safeParse(i);
    return p.success ? [p.data] : [];
  });
}

/** One hold, or null when it doesn't exist or belongs to someone else. */
export async function approvalById(id: string): Promise<ApprovalItem | null> {
  if (!Id.safeParse(id).success) return null;
  try {
    const res = await gatewayFetch<unknown>(`/human/approvals/${id}`, {
      scope: 'approvals:decide',
    });
    const p = ApprovalItemSchema.safeParse(res);
    return p.success ? p.data : null;
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.NOT_FOUND) return null;
    throw err;
  }
}

/** Approve (capture) or deny (void) a hold. A 409 comes back as the gateway's own sentence. */
export async function decideApproval(
  id: string,
  decision: 'approve' | 'deny',
  via: 'web' | 'phone',
): Promise<DecideResult> {
  if (!Id.safeParse(id).success) return { ok: false, message: 'This hold no longer exists.' };
  try {
    const { state } = await gatewayFetch<{ state: ApprovalState }>(`/human/approvals/${id}`, {
      method: 'POST',
      scope: 'approvals:decide',
      body: { decision, via },
    });
    return { ok: true, state };
  } catch (err) {
    if (err instanceof AppError) {
      if (err.code === ErrorCode.CONFLICT) return { ok: false, message: sentence(err.message) };
      if (err.code === ErrorCode.NOT_FOUND) {
        return { ok: false, message: 'This hold no longer exists.' };
      }
      if (err.code === ErrorCode.UNAUTHENTICATED) return { ok: false, message: 'Sign in again.' };
    }
    return { ok: false, message: 'Nothing changed. Try again.' };
  }
}

/** Stores this browser's push subscription at the gateway, which sends the pushes. */
export async function savePushSubscription(sub: unknown): Promise<PushResult> {
  const parsed = Subscription.safeParse(sub);
  if (!parsed.success) return { ok: false, message: 'This browser gave an unusable subscription.' };
  try {
    await gatewayFetch('/human/push-subscriptions', {
      method: 'POST',
      scope: 'push:manage',
      body: parsed.data,
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.VALIDATION) {
      return { ok: false, message: 'This browser’s push service is not supported.' };
    }
    return { ok: false, message: 'Could not turn on alerts. Try again.' };
  }
}

export async function removePushSubscription(endpoint: string): Promise<PushResult> {
  try {
    await gatewayFetch('/human/push-subscriptions', {
      method: 'DELETE',
      scope: 'push:manage',
      body: { endpoint },
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AppError && err.code === ErrorCode.NOT_FOUND) return { ok: true };
    return { ok: false, message: 'Could not turn off alerts. Try again.' };
  }
}
