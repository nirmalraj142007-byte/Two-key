'use client';

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { ErrorState, LoadingState } from '@/components/twokey/state-panels';
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
}: {
  summary: ResultsSummary;
  inside: ReactNode;
  predictions: ReactNode;
}) {
  return (
    <Tabs defaultValue="cross-model" className="gap-6">
      <TabsList variant="line" className="flex-wrap">
        <TabsTrigger value="cross-model">Cross-model</TabsTrigger>
        <TabsTrigger value="frontier">Frontier</TabsTrigger>
        <TabsTrigger value="inside">Inside the rules</TabsTrigger>
        <TabsTrigger value="predictions">Predictions</TabsTrigger>
      </TabsList>
      <TabsContent value="cross-model">
        <CrossModelChart summary={summary} />
      </TabsContent>
      <TabsContent value="frontier">
        <FrontierChart summary={summary} />
      </TabsContent>
      <TabsContent value="inside">{inside}</TabsContent>
      <TabsContent value="predictions">{predictions}</TabsContent>
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
