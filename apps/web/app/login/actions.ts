'use server';

import { AuthError } from 'next-auth';
import { signIn } from '@/auth';

export type LoginState = { error: string | null };

export async function login(_prev: LoginState, form: FormData): Promise<LoginState> {
  try {
    await signIn('credentials', {
      email: form.get('email'),
      password: form.get('password'),
      redirectTo: '/onboarding/paypal',
    });
  } catch (err) {
    // One message for every failure: never say whether the email exists.
    if (err instanceof AuthError) return { error: 'Wrong email or password' };
    throw err; // includes the redirect on success
  }
  return { error: null };
}
