import { BOOT_HINTS_KEY } from './keys';

/**
 * What the rail showed, for the next page load's skeleton: the apps and the
 * optional footer items whose presence depends on the server (capabilities,
 * admin rights, quota), which nothing else keeps across a reload. The boot
 * script turns it into `data-boot-rail` (lib/boot-skeleton/boot-script.ts).
 */
export type RailHint = 'calendar' | 'contacts' | 'files' | 'add-app' | 'admin' | 'a11y' | 'quota';

let lastWritten: string | null = null;

export function writeRailHints(items: RailHint[]): void {
  const rail = ['mail', ...items];
  const value = JSON.stringify({ v: 1, rail });
  if (value === lastWritten) return;
  lastWritten = value;
  try {
    localStorage.setItem(BOOT_HINTS_KEY, value);
  } catch {
    /* storage full or blocked: the next skeleton draws every app */
  }
}

/** For tests. */
export function resetRailHintsMemo(): void {
  lastWritten = null;
}
