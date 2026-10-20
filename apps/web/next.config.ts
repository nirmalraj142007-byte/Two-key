import { join } from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@twokey/core', '@twokey/db'],
  cacheComponents: true,
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
