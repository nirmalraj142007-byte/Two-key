import { type NextRequest, NextResponse } from 'next/server';
import { contentSecurityPolicy } from './lib/csp';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs before every page, route handler and server action:
 * - x-request-id: kept when the caller sent a UUID, else a fresh one. Route handlers and
 *   gatewayFetch read it from the request headers and forward it to the gateway.
 * - Content-Security-Policy with a per-request nonce (Next's recommended strategy). Next reads
 *   the nonce from the request's CSP header and puts it on every script it renders.
 */
export function proxy(request: NextRequest) {
  const incoming = request.headers.get('x-request-id');
  const requestId = incoming && UUID.test(incoming) ? incoming.toLowerCase() : crypto.randomUUID();
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy({
    nonce,
    gatewayUrl: process.env.GATEWAY_URL,
    dev: process.env.NODE_ENV === 'development',
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-request-id', requestId);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('x-request-id', requestId);
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    // Everything except build assets and static files (they carry no inline script).
    {
      source: '/((?!_next/static|_next/image|favicon.ico|icons/|sw.js|manifest.webmanifest).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
