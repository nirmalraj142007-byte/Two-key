import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@twokey/core'],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      '*.css': {
        loaders: ['@tailwindcss/turbopack'],
        as: '*.css',
      },
    },
  },
};

export default nextConfig;
