import type { MetadataRoute } from 'next';

// Colours are the light theme's tokens in globals.css (--bg, --accent).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Two-Key',
    short_name: 'Two-Key',
    description: "The lock on an AI agent's PayPal wallet",
    start_url: '/approvals',
    scope: '/',
    display: 'standalone',
    background_color: '#f8f8f6',
    theme_color: '#2747c4',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
