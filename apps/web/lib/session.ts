import { redirect } from 'next/navigation';
import { connection } from 'next/server';
import { auth } from '@/auth';

export interface CurrentUser {
  userId: string;
  role: 'user' | 'judge_demo' | 'hijack_system';
}

/** The signed-in user, or a redirect to /login. Reads the request, so call it inside <Suspense>. */
export async function requireUser(): Promise<CurrentUser> {
  // Request-time only: auth() re-encrypts the session cookie, which uses randomness.
  await connection();
  const session = await auth();
  if (!session?.userId) redirect('/login');
  return { userId: session.userId, role: session.role };
}
