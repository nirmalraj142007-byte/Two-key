import { AppError, createLogger } from '@twokey/core';
import { connection, type NextRequest } from 'next/server';
import { webEnv } from '@/lib/env';
import { listEpisodes } from '@/lib/episodes-queries';
import { parseEpisodeFilters } from '@/lib/episodes-view';

/**
 * Public: evaluation runs as rows (listing IDs, redacted titles, gate outcomes), filtered by
 * model, gate, set, variant, target, outcome and split; 200 rows per page.
 */
export async function GET(req: NextRequest) {
  await connection();
  const requestId = crypto.randomUUID();
  const headers = { 'x-request-id': requestId };
  const { filters, invalid } = parseEpisodeFilters(Object.fromEntries(req.nextUrl.searchParams));
  if (invalid.length > 0) {
    return Response.json(
      {
        error: { code: 'VALIDATION', message: `Invalid filter: ${invalid.join(', ')}`, requestId },
      },
      { status: 400, headers },
    );
  }
  try {
    const page = await listEpisodes(filters);
    return Response.json(
      {
        split: page.split,
        total: page.total,
        page: page.page,
        pages: page.pages,
        pageSize: page.pageSize,
        rows: page.rows.map(({ hasProposal: _, runId: __, ...row }) => row),
      },
      { headers: { ...headers, 'cache-control': 'public, max-age=60' } },
    );
  } catch (err) {
    createLogger('web', webEnv().LOG_LEVEL).error({ err, requestId }, 'results episodes failed');
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    return Response.json(
      { error: { code, message: 'Results are unavailable right now', requestId } },
      { status: 503, headers },
    );
  }
}
