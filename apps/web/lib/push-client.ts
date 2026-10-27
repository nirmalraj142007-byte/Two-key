'use client';

import { removePushSubscription, savePushSubscription } from '@/app/approvals/actions';
import { sameKey, urlBase64ToBytes } from './approvals-view';

/** `off`: supported but not turned on yet (permission not asked, or no subscription). */
export type PushStatus = 'unsupported' | 'denied' | 'enabled' | 'off';

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** iPhone and iPad (iPadOS reports itself as a Mac with touch). */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1)
  );
}

/** Running as an installed home-screen app. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!isPushSupported()) return null;
  return navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

/**
 * Where this browser stands. `enabled` only for a subscription made with our VAPID key; that
 * subscription is saved to the gateway again (an idempotent upsert), so the gateway always
 * knows it, also after another account signed in on this browser.
 */
export async function pushStatus(vapidPublicKey: string | null): Promise<PushStatus> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted' || !vapidPublicKey) return 'off';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub || !sameKey(sub.options.applicationServerKey, urlBase64ToBytes(vapidPublicKey))) {
    return 'off';
  }
  const saved = await savePushSubscription(sub.toJSON());
  return saved.ok ? 'enabled' : 'off';
}

/**
 * Asks for permission, subscribes with the VAPID public key and stores the subscription at the
 * gateway (through a server action). Must run from a tap: browsers refuse prompts otherwise.
 */
export async function subscribe(
  vapidPublicKey: string,
): Promise<{ status: PushStatus; message?: string }> {
  if (!isPushSupported()) return { status: 'unsupported' };
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return { status: 'denied' };
  if (permission !== 'granted') return { status: 'off' };
  const reg = await registerServiceWorker();
  if (!reg) return { status: 'unsupported' };
  await navigator.serviceWorker.ready;
  const key = urlBase64ToBytes(vapidPublicKey);
  let sub = await reg.pushManager.getSubscription();
  // A subscription made with another VAPID key (a rotated key, another server) can never
  // receive our pushes: drop it and subscribe again.
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const saved = await savePushSubscription(sub.toJSON());
  if (!saved.ok) return { status: 'off', message: saved.message };
  return { status: 'enabled' };
}

export async function unsubscribe(): Promise<{ status: PushStatus; message?: string }> {
  if (!isPushSupported()) return { status: 'unsupported' };
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return { status: 'off' };
  const removed = await removePushSubscription(sub.endpoint);
  await sub.unsubscribe();
  return removed.ok ? { status: 'off' } : { status: 'off', message: removed.message };
}
