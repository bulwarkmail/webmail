/**
 * The print style the user picked (Settings > Appearance > Printing), while
 * its plugin runs; null prints the standard way.
 */

import { useSettingsStore } from '@/stores/settings-store';
import { findPrintTheme, usePrintThemes, type RegisteredPrintTheme } from '@/lib/plugin-sandbox/print-themes';

export function activePrintTheme(): RegisteredPrintTheme | null {
  return findPrintTheme(useSettingsStore.getState().printTheme);
}

export function useActivePrintTheme(): RegisteredPrintTheme | null {
  const key = useSettingsStore((s) => s.printTheme);
  const themes = usePrintThemes();
  return themes.find((t) => t.key === key) ?? null;
}
