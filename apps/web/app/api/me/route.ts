import { auth } from '@/auth';

export async function GET() {
  const session = await auth();
  if (!session?.userId) {
    return Response.json(
      {
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Sign in first',
          requestId: crypto.randomUUID(),
        },
      },
      { status: 401 },
    );
  }
  return Response.json({ userId: session.userId, role: session.role });
}
