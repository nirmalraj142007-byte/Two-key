import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import { HealthBanner } from '@/components/twokey/HealthBanner';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

export const metadata: Metadata = {
  title: 'Two-Key',
  description: "The lock on an AI agent's PayPal wallet",
  appleWebApp: { capable: true, title: 'Two-Key', statusBarStyle: 'default' },
  icons: { apple: '/icons/icon-192.png' },
};

// viewport-fit=cover lets the phone approval screen pad itself with the safe-area insets.
export const viewport: Viewport = { themeColor: '#2747c4', viewportFit: 'cover' };

// Content-Security-Policy nonces (proxy.ts) only reach pages rendered per request, so no page
// is prerendered: the root layout waits for the request, and `instant = false` lets every
// route block on it instead of shipping a static shell whose scripts would carry no nonce.
// Data caching ('use cache') is unaffected.
export const instant = false;

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  await connection();
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <HealthBanner />
        <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
