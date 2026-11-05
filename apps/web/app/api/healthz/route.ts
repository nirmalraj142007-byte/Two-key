import { connection } from 'next/server';

export async function GET() {
  // Request time, so the commit is the running deploy's (Render sets RENDER_GIT_COMMIT).
  await connection();
  return Response.json({
    ok: true,
    service: 'web',
    commit: process.env.RENDER_GIT_COMMIT ?? 'dev',
  });
}
