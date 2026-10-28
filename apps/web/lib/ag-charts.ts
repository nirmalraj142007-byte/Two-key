'use client';

import { AllCommunityModule, ModuleRegistry } from 'ag-charts-community';
import { useEffect, useState } from 'react';

/**
 * AG Charts (Community), registered once per page load. Import only from client components
 * loaded with next/dynamic ({ ssr: false }), like lib/ag-grid.ts.
 */
let registered = false;
export function setupAgCharts(): void {
  if (registered) return;
  ModuleRegistry.registerModules(AllCommunityModule);
  registered = true;
}

/** The design tokens from globals.css, resolved for the canvas (it cannot read CSS variables). */
export interface ChartTokens {
  text: string;
  muted: string;
  border: string;
  accent: string;
  surface: string;
  surfaceRaised: string;
  font: string;
}

const FALLBACK: ChartTokens = {
  text: 'black',
  muted: 'gray',
  border: 'lightgray',
  accent: 'blue',
  surface: 'white',
  surfaceRaised: 'white',
  font: 'system-ui, sans-serif',
};

function readTokens(): ChartTokens {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  return {
    text: v('--text', FALLBACK.text),
    muted: v('--text-muted', FALLBACK.muted),
    border: v('--border', FALLBACK.border),
    accent: v('--accent', FALLBACK.accent),
    surface: v('--surface', FALLBACK.surface),
    surfaceRaised: v('--surface-raised', FALLBACK.surfaceRaised),
    font: `${v('--font-geist-sans', '')}, ui-sans-serif, system-ui, sans-serif`.replace(/^, /, ''),
  };
}

/** Tokens for the current colour scheme; re-read when the OS scheme or data-theme changes. */
export function useChartTokens(): ChartTokens | null {
  const [tokens, setTokens] = useState<ChartTokens | null>(null);
  useEffect(() => {
    const update = () => setTokens(readTokens());
    update();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      media.removeEventListener('change', update);
      observer.disconnect();
    };
  }, []);
  return tokens;
}

/** Shared axis and chart styling on the tokens. */
export function baseChartTheme(t: ChartTokens) {
  return {
    background: { fill: t.surfaceRaised },
    axisLabel: { color: t.muted, fontFamily: t.font, fontSize: 12 },
    axisTitle: { color: t.muted, fontFamily: t.font, fontSize: 12 },
    gridLine: { stroke: t.border },
    axisLine: { stroke: t.border },
    legendItem: { color: t.text, fontFamily: t.font, fontSize: 12 },
  };
}
