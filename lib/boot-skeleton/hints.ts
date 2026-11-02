import { BOOT_HINTS_KEY } from './keys';

/**
 * What the rail showed, for the next page load's skeleton: the apps and the
 * optional footer items whose presence depends on the server (capabilities,
 * admin rights, quota), which nothing else keeps across a reload. The boot
 * script turns it into `data-boot-rail` (lib/boot-skeleton/boot-script.ts).
 */
export type RailHint = 'calendar' | 'contacts' | 'files' | 'add-app' | 'admin' | 'a11y' | 'quota';

let lastWritten: string | null = null;

/** Replaces one part of the stored hints and keeps the others. */
function writeHints(patch: { rail?: string[]; settings?: string[] }): void {
  let stored: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(localStorage.getItem(BOOT_HINTS_KEY) || 'null');
    if (parsed && typeof parsed === 'object' && parsed.v === 1) stored = parsed;
  } catch {
    /* corrupt or blocked: start over */
  }
  const value = JSON.stringify({ ...stored, ...patch, v: 1 });
  if (value === lastWritten) return;
  lastWritten = value;
  try {
    localStorage.setItem(BOOT_HINTS_KEY, value);
  } catch {
    /* storage full or blocked: the next skeleton draws its defaults */
  }
}

export function writeRailHints(items: RailHint[]): void {
  writeHints({ rail: ['mail', ...items] });
}

/**
 * The pages the settings nav listed for this account, which depend on its
 * capabilities and the admin's policy. The boot script turns it into
 * `data-boot-settings-tabs`.
 */
export function writeSettingsHints(tabs: string[]): void {
  writeHints({ settings: tabs });
}

/** For tests. */
export function resetRailHintsMemo(): void {
  lastWritten = null;
}
