import { Suspense } from 'react';
import { gatewayFetch } from '@/lib/gateway';
import { requireUser } from '@/lib/session';
import { type Progress, ProgressSteps, StepsPlaceholder } from './steps';

export async function getProgress(): Promise<Progress | null> {
  await requireUser();
  try {
    const me = await gatewayFetch<Progress>('/human/me');
    return { vaultConnected: me.vaultConnected, activeCardId: me.activeCardId };
  } catch {
    return null; // the header still renders; each page shows its own error state
  }
}

async function LoadedSteps() {
  return <ProgressSteps progress={await getProgress()} />;
}

/** The 3-step header shared by /onboarding/* and /rules/*. Reads the session, so it streams. */
export function SetupHeader() {
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-4">
      <p className="text-sm font-medium tracking-wide text-text-muted">Two-Key setup</p>
      <Suspense fallback={<StepsPlaceholder />}>
        <LoadedSteps />
      </Suspense>
    </header>
  );
}
