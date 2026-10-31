'use server';

import { headers } from 'next/headers';
import { AuthError } from 'next-auth';
import { signIn } from '@/auth';
import { clearLoginAttempts, clientIp, consumeLoginAttempt, ipHash } from '@/lib/rate-limit';

const TOO_MANY_ATTEMPTS = 'Too many sign-in attempts. Wait a minute, then try again.';

export type LoginState = { error: string | null };

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  const key = ipHash(clientIp(await headers()));
  if (!(await consumeLoginAttempt(key))) return { error: TOO_MANY_ATTEMPTS };
  try {
    await signIn('credentials', {
      email: form.get('email'),
      password: form.get('password'),
      redirectTo: '/onboarding/paypal',
    });
  } catch (err) {
    // One message for every failure: never say whether the email exists.
    if (err instanceof AuthError) return { error: 'Wrong email or password' };
    // signIn redirects on success by throwing; a good password clears this IP's count.
    if (String((err as { digest?: unknown }).digest ?? '').startsWith('NEXT_REDIRECT')) {
      await clearLoginAttempts(key);
    }
    throw err;
  }
  return { error: null };
}
