import { AppError, ErrorCode } from '@twokey/core';

const TIMEOUT_MS = 10_000;

export interface SearchItem {
  product_id: string;
  title: string;
  store: string;
  price_usd: string;
  category: string;
  untrusted_listing_text: string;
}

export interface SearchResult {
  items: SearchItem[];
  unmapped_offers?: number;
}

export interface ProposalDecision {
  proposalId: string;
  decision: 'captured' | 'held' | 'blocked' | 'failed' | 'pending';
  reason: string;
  paymentState?: string;
  retryable?: boolean;
}

export interface PurchaseStatus {
  decision: string;
  paymentState: string | null;
}

/** The only thing MCP can reach: the gateway's /agent routes, with one agent token. */
export interface Gateway {
  search(q: string, maxPriceUsd?: number, limit?: number): Promise<SearchResult>;
  propose(productId: string, qty: number, idempotencyKey: string): Promise<ProposalDecision>;
  status(proposalId: string): Promise<PurchaseStatus>;
  rules(): Promise<Record<string, unknown>>;
}

const KNOWN_CODES = new Set<string>(Object.values(ErrorCode));

export class GatewayClient implements Gateway {
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  search(q: string, maxPriceUsd?: number, limit?: number): Promise<SearchResult> {
    const params = new URLSearchParams({ q });
    if (maxPriceUsd !== undefined) {
      params.set('max_price_cents', String(Math.round(maxPriceUsd * 100)));
    }
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request('GET', `/agent/catalog/search?${params}`);
  }

  propose(productId: string, qty: number, idempotencyKey: string): Promise<ProposalDecision> {
    // Only product_id and qty are ever sent; the gateway resolves price and payee itself.
    return this.request('POST', '/agent/proposals', { product_id: productId, qty }, idempotencyKey);
  }

  status(proposalId: string): Promise<PurchaseStatus> {
    return this.request('GET', `/agent/purchases/${encodeURIComponent(proposalId)}`);
  }

  rules(): Promise<Record<string, unknown>> {
    return this.request('GET', '/agent/rules');
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      throw new AppError(
        ErrorCode.INTERNAL,
        timedOut
          ? 'Two-Key did not answer in time. Try again.'
          : 'Could not reach Two-Key. Try again.',
        { retryable: true },
      );
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      const code = e?.code && KNOWN_CODES.has(e.code) ? (e.code as ErrorCode) : ErrorCode.INTERNAL;
      throw new AppError(code, e?.message ?? 'Two-Key could not complete the request', {
        httpStatus: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }
    return json as T;
  }
}
