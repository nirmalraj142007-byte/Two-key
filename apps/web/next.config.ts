import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@twokey/core', '@twokey/db', '@twokey/eval'],
  // pg-boss (agent.run sends) and the hijack rate limiter load pg at runtime; keep them out of
  // the server bundle.
  serverExternalPackages: ['pg-boss', 'pg', 'rate-limiter-flexible'],
  cacheComponents: true,
  poweredByHeader: false,
  // Static security headers on every response. The Content-Security-Policy needs a fresh nonce
  // per request, so proxy.ts sets it.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
      // Workspace packages import './x.js' for './x.ts' (NodeNext); see the loader.
      '*.ts': {
        condition: { all: [{ not: 'foreign' }, { path: /packages\/[^/]+\/src\// }] },
        loaders: [join(process.cwd(), 'loaders', 'strip-js-extension.cjs')],
        as: '*.ts',
      },
    },
  },
};

export default nextConfig;
