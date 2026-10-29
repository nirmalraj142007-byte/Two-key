'use client';

import { useEffect, useState } from 'react';
import { readForced } from './test-states';

/**
 * Client-side `?__state=` for screens without a server component to read it. Read after mount
 * from the URL, so static pages stay static; always null in production.
 */
export function useForcedState<T extends string>(allowed: readonly T[]): T | null {
  const [state, setState] = useState<T | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: read once on mount.
  useEffect(() => {
    setState(readForced(new URLSearchParams(window.location.search), allowed));
  }, []);
  return state;
}
