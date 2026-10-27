'use client';

import { AllCommunityModule, ModuleRegistry, themeQuartz } from 'ag-grid-community';

/**
 * AG Grid, set up once per page load. Import this only from client components loaded with
 * next/dynamic ({ ssr: false }) so the grid never lands in the shared first-load JS.
 *
 * With NEXT_PUBLIC_AG_GRID_LICENSE_KEY set, the Enterprise row grouping and master/detail
 * modules are loaded and licensed. Without it, Enterprise code is never downloaded (so no
 * watermark) and grids use their Community fallbacks; `enterprise` tells them which.
 */
export interface AgGridSetup {
  enterprise: boolean;
}

const LICENSE_KEY = process.env.NEXT_PUBLIC_AG_GRID_LICENSE_KEY;

let setup: Promise<AgGridSetup> | null = null;

export function setupAgGrid(): Promise<AgGridSetup> {
  setup ??= (async () => {
    ModuleRegistry.registerModules([AllCommunityModule]);
    if (!LICENSE_KEY) {
      console.warn(
        'NEXT_PUBLIC_AG_GRID_LICENSE_KEY is not set: AG Grid runs Community features only.',
      );
      return { enterprise: false };
    }
    const { LicenseManager, MasterDetailModule, RowGroupingModule } = await import(
      'ag-grid-enterprise'
    );
    LicenseManager.setLicenseKey(LICENSE_KEY);
    ModuleRegistry.registerModules([RowGroupingModule, MasterDetailModule]);
    return { enterprise: true };
  })();
  return setup;
}

/** The Quartz theme on the Two-Key tokens (globals.css), so it follows light and dark mode. */
export const gridTheme = themeQuartz.withParams({
  backgroundColor: 'var(--surface-raised)',
  foregroundColor: 'var(--text)',
  textColor: 'var(--text)',
  subtleTextColor: 'var(--text-muted)',
  borderColor: 'var(--border)',
  accentColor: 'var(--accent)',
  headerBackgroundColor: 'var(--surface)',
  headerTextColor: 'var(--text-muted)',
  rowHoverColor: 'var(--surface)',
  oddRowBackgroundColor: 'var(--surface-raised)',
  selectedRowBackgroundColor: 'var(--surface)',
  fontFamily: 'var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif',
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 500,
  rowHeight: 44,
  headerHeight: 40,
  wrapperBorderRadius: 8,
  spacing: 6,
  focusShadow: '0 0 0 2px var(--focus)',
});
