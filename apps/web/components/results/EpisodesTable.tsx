'use client';

import dynamic from 'next/dynamic';
import { LoadingState } from '@/components/twokey/state-panels';
import type { EpisodeRow } from '@/lib/episodes-view';

// AG Grid loads in the browser only, so it stays out of the shared first-load JS.
const EpisodesGrid = dynamic(() => import('@/components/grids/EpisodesGrid'), {
  ssr: false,
  loading: () => <LoadingState rows={4} />,
});

export function EpisodesTable({ rows }: { rows: EpisodeRow[] }) {
  return <EpisodesGrid rows={rows} />;
}
