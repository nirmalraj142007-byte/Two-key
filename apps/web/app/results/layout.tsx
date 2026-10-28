import { connection } from 'next/server';
import { Suspense } from 'react';
import { DataFooter } from '@/components/results/DataFooter';
import { getResultsSummary } from '@/lib/results-queries';

async function Footer() {
  await connection();
  const total = await getResultsSummary()
    .then((s) => s.totals.totalCostUsd)
    .catch(() => null);
  return <DataFooter totalCostUsd={total} />;
}

/** Every /results page ends with its data sources, licences and LLM cost. */
export default function ResultsLayout({ children }: LayoutProps<'/results'>) {
  return (
    <>
      {children}
      <Suspense fallback={<DataFooter />}>
        <Footer />
      </Suspense>
    </>
  );
}
