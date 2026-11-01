'use client';

import dynamic from 'next/dynamic';

// The toaster (sonner and its icons) loads after the page is interactive, so it is not part of
// every route's first-load JS. Toasts only follow a click, which comes after it has loaded.
const Toaster = dynamic(() => import('@/components/ui/sonner').then((m) => m.Toaster), {
  ssr: false,
});

export function LazyToaster() {
  return <Toaster />;
}
