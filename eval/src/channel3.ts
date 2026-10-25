import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Channel3Api } from '@channel3/sdk';
import { Channel3 } from '@channel3/sdk';
import { AppError, ErrorCode } from '@twokey/core';

export const CACHE_DIR = 'eval/data/channel3-cache';
export const SEARCH_LIMIT = 10;
const ATTEMPTS = 3; // one call plus two retries

export type Channel3Fetch = (query: string, limit: number) => Promise<Channel3Api.Product[]>;

export interface CachedSearch {
  taskId: string;
  query: string;
  limit: number;
  fetchedAt: string;
  products: Channel3Api.Product[];
}

export function sdkFetch(apiKey: string): Channel3Fetch {
  const client = new Channel3({ apiKey, timeoutInSeconds: 20, maxRetries: 0 });
  return async (query, limit) => (await client.products.search({ query, limit })).data;
}

/**
 * Channel3 search through an on-disk cache: one file per task, written once. A cached task is
 * never queried again, so a rebuild spends no credits. With no fetcher, a miss is an error.
 */
export class Channel3Cache {
  calls = 0;
  hits = 0;

  constructor(
    private readonly dir: string,
    private readonly fetcher: Channel3Fetch | undefined,
    private readonly maxCalls: number,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  path(taskId: string): string {
    return join(this.dir, `${taskId}.json`);
  }

  async search(taskId: string, query: string): Promise<Channel3Api.Product[]> {
    const file = this.path(taskId);
    if (existsSync(file)) {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as CachedSearch;
      if (cached.query !== query) {
        throw new AppError(
          ErrorCode.CONFIG_INVALID,
          `Cached Channel3 response ${file} is for a different query; refusing to re-query`,
        );
      }
      this.hits++;
      return cached.products;
    }
    if (!this.fetcher) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID,
        `No cached Channel3 response for task ${taskId} and CHANNEL3_API_KEY is not set (.env.eval)`,
      );
    }
    if (this.calls >= this.maxCalls) {
      throw new AppError(
        ErrorCode.BUDGET_EXCEEDED,
        `Reached the Channel3 call limit (${this.maxCalls}); build stopped, nothing written to the database`,
      );
    }
    let lastErr: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      this.calls++;
      try {
        const products = await this.fetcher(query, SEARCH_LIMIT);
        const entry: CachedSearch = {
          taskId,
          query,
          limit: SEARCH_LIMIT,
          fetchedAt: new Date().toISOString(),
          products,
        };
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(file, `${JSON.stringify(entry, null, 1)}\n`);
        return products;
      } catch (err) {
        lastErr = err;
        if (attempt < ATTEMPTS) await this.sleep(2000 * attempt);
      }
    }
    throw new AppError(
      ErrorCode.UPSTREAM_CHANNEL3,
      `Channel3 search failed ${ATTEMPTS} times for task ${taskId}; build stopped, nothing written to the database`,
      { cause: lastErr },
    );
  }
}
