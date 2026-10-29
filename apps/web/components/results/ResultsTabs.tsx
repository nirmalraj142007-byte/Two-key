'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/twokey/state-panels';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { ResultsSummary } from '@/lib/results-queries';

// Charts load in the browser only, so AG Charts stays out of the shared first-load JS.
const CrossModelChart = dynamic(() => import('./CrossModelChart'), {
  ssr: false,
  loading: () => <LoadingState rows={3} />,
});
const FrontierChart = dynamic(() => import('./FrontierChart'), {
  ssr: false,
  loading: () => <LoadingState rows={3} />,
});

export function ResultsTabs({
  summary,
  inside,
  predictions,
  episodes,
  judge,
  initialTab = 'cross-model',
}: {
  summary: ResultsSummary;
  inside: ReactNode;
  predictions: ReactNode;
  episodes: ReactNode;
  judge: ReactNode;
  initialTab?: string;
}) {
  const [tab, setTab] = useState(initialTab);
  // Deep link: /results#inside-the-rules opens that panel (linked from /about).
  useEffect(() => {
    const fromHash = () => {
      if (window.location.hash === '#inside-the-rules') setTab('inside');
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);
  return (
    <Tabs id="inside-the-rules" value={tab} onValueChange={setTab} className="gap-6">
      <TabsList variant="line" className="flex-wrap">
        <TabsTrigger value="cross-model">Cross-model</TabsTrigger>
        <TabsTrigger value="frontier">Frontier</TabsTrigger>
        <TabsTrigger value="inside">Inside the rules</TabsTrigger>
        <TabsTrigger value="predictions">Predictions</TabsTrigger>
        <TabsTrigger value="episodes">Episodes</TabsTrigger>
        <TabsTrigger value="judge">Judge-written attacks</TabsTrigger>
      </TabsList>
      <TabsContent value="cross-model">
        <CrossModelChart summary={summary} />
      </TabsContent>
      <TabsContent value="frontier">
        <FrontierChart summary={summary} />
      </TabsContent>
      <TabsContent value="inside">{inside}</TabsContent>
      <TabsContent value="predictions">{predictions}</TabsContent>
      <TabsContent value="episodes">{episodes}</TabsContent>
      <TabsContent value="judge">{judge}</TabsContent>
    </Tabs>
  );
}

export function ResultsError() {
  const router = useRouter();
  return (
    <ErrorState
      title="Results could not load"
      body="The evaluation numbers are unavailable right now."
      retry={() => router.refresh()}
    />
  );
}

/** The results page while its numbers load: the header line, three model cards and a chart. */
export function ResultsSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">Loading results…</span>
      <Skeleton aria-hidden="true" className="h-5 w-3/4" />
      <div aria-hidden="true" className="grid gap-3 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-border bg-surface-raised p-4"
          >
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ))}
      </div>
      <div
        aria-hidden="true"
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4"
      >
        <Skeleton className="h-4 w-1/4" />
        <div className="flex h-64 items-end gap-4">
          {[40, 75, 55, 90, 30, 65].map((h) => (
            <Skeleton key={h} className="flex-1" style={{ height: `${h}%` }} />
          ))}
        </div>
      </div>
    </div>
  );
}
