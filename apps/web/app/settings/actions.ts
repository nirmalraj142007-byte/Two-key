'use server';

import { refresh } from 'next/cache';
import { z } from 'zod';
import { signOut } from '@/auth';
import { gatewayFetch } from '@/lib/gateway';
import { requireUser } from '@/lib/session';

export type SettingsResult =
  | { status: 'idle' }
  | { status: 'ok' }
  | { status: 'error'; message: string };

const CardId = z.uuid();

/** Revokes one signed rule card. The gateway checks the card belongs to the asserted user. */
export async function revokeRules(id: string, _prev: SettingsResult): Promise<SettingsResult> {
  await requireUser();
  const parsed = CardId.safeParse(id);
  if (!parsed.success) return { status: 'error', message: 'Those rules could not be found.' };
  try {
    await gatewayFetch(`/human/rules/${parsed.data}/revoke`, {
      method: 'POST',
      scope: 'rules:sign',
    });
  } catch {
    return { status: 'error', message: 'Could not revoke your rules. Try again.' };
  }
  refresh();
  return { status: 'ok' };
}

/** Removes the saved PayPal wallet. Demo accounts are refused by the gateway as well. */
export async function disconnectPayPal(_prev: SettingsResult): Promise<SettingsResult> {
  const user = await requireUser();
  if (user.role === 'judge_demo') {
    return { status: 'error', message: "Demo accounts can't disconnect PayPal." };
  }
  try {
    await gatewayFetch('/human/vault', { method: 'DELETE', scope: 'vault:manage' });
  } catch {
    return { status: 'error', message: 'Could not disconnect PayPal. Try again.' };
  }
  refresh();
  return { status: 'ok' };
}

export async function signOutAction() {
  await signOut({ redirectTo: '/' });
}
