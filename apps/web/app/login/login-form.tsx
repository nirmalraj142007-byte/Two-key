'use client';

import { LoaderCircleIcon } from 'lucide-react';
import { useActionState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useForcedState } from '@/lib/use-forced-state';
import { type LoginState, login } from './actions';

const initial: LoginState = { error: null };
const FORCED = ['loading', 'error', 'success'] as const;

export function LoginForm() {
  const [state, action, actionPending] = useActionState(login, initial);
  const forced = useForcedState(FORCED);
  const pending = actionPending || forced === 'loading';
  const error = forced === 'error' ? 'Wrong email or password' : state.error;

  if (forced === 'success') {
    // A successful sign-in redirects; this is what shows while the next page loads.
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-text-muted">
        <LoaderCircleIcon aria-hidden="true" className="size-4 animate-spin" />
        Signed in. Opening Two-Key…
      </p>
    );
  }

  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-sm font-medium text-text">
          Email
        </label>
        <Input id="email" name="email" type="email" autoComplete="username" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-sm font-medium text-text">
          Password
        </label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
      </div>
      {error && !pending ? (
        <p role="alert" className="text-sm text-text">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending} aria-busy={pending}>
        {pending ? (
          <>
            <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
            Signing in…
          </>
        ) : (
          'Sign in'
        )}
      </Button>
    </form>
  );
}
