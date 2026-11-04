/**
 * Recent files in the composer's Attach menu, in the desktop app only. The shell reads the
 * OS's list when the menu opens and hands over what the menu shows; attaching sends back an
 * id, and the bytes come back as a File for the composer's own checks, as a file from the
 * file dialog does. In a browser there's no bridge, and nothing here offers anything.
 */

import { useSyncExternalStore } from 'react';
import { getDesktopBridge } from './bridge';
import { getDesktopPolicy, onDesktopPolicyChange } from './policy';
import type { PolicySnapshot } from './policy-schema';
import type { DesktopRecentFile } from './types';

/** The shell's limit for one file, the same as for a file from "Open with" (HANDOFF_MAX_BYTES). */
export const RECENT_FILE_MAX_BYTES = 100 * 1024 * 1024;

/** The shell has the list and the RecentFilesInAttach policy doesn't hide it. */
export function recentFilesOffered(policy: PolicySnapshot = getDesktopPolicy()): boolean {
  return !!getDesktopBridge()?.recentFiles && policy.RecentFilesInAttach?.value !== false;
}

/** recentFilesOffered, live. False in the server's render, so the first render in the page matches it. */
export function useRecentFilesOffered(): boolean {
  return useSyncExternalStore(onDesktopPolicyChange, () => recentFilesOffered(), () => false);
}

/** Straight from the click that opened the menu: main wants one. Empty when there's nothing to show. */
export async function listRecentFiles(): Promise<DesktopRecentFile[]> {
  const bridge = getDesktopBridge()?.recentFiles;
  if (!bridge) return [];
  try {
    const result = await bridge.list();
    return result.ok ? result.files : [];
  } catch {
    return [];
  }
}

export type RecentFileAttach =
  | { ok: true; file: File }
  | { ok: false; reason: 'missing' | 'too-large' | 'failed' | 'quiet' };

/** Straight from the click on the row. `quiet`: nothing worth telling the user (locked, or switched off). */
export async function readRecentFile(id: string): Promise<RecentFileAttach> {
  const bridge = getDesktopBridge()?.recentFiles;
  if (!bridge) return { ok: false, reason: 'quiet' };
  try {
    const result = await bridge.attach(id);
    if (result.ok) return { ok: true, file: new File([new Uint8Array(result.file.data)], result.file.name) };
    if (result.reason === 'missing' || result.reason === 'too-large') return { ok: false, reason: result.reason };
    // Locked or switched off since the menu opened: the page shows that itself.
    if (result.reason === 'locked' || result.reason === 'policy') return { ok: false, reason: 'quiet' };
    // An id from a list a newer one replaced, or a click main didn't see: worth another try.
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}

/**
 * A long folder as its start and its end, which tell it apart: the drive or the share, then
 * the folders nearest the file. The middle goes, where a path's end would under an ellipsis.
 */
export function shortFolder(folder: string, max = 44): string {
  if (folder.length <= max) return folder;
  const sep = folder.includes('\\') ? '\\' : '/';
  const parts = folder.split(sep);
  // \\server\share, or C:, or the empty start of /home.
  const rootCount = folder.startsWith('\\\\') ? 4 : 1;
  if (parts.length <= rootCount + 1) return folder;
  const root = parts.slice(0, rootCount).join(sep);
  let tail = parts.slice(rootCount);
  while (tail.length > 1 && `${root}${sep}…${sep}${tail.join(sep)}`.length > max) tail = tail.slice(1);
  return `${root}${sep}…${sep}${tail.join(sep)}`;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 60 * 60_000],
  ['month', 30 * 24 * 60 * 60_000],
  ['week', 7 * 24 * 60 * 60_000],
  ['day', 24 * 60 * 60_000],
  ['hour', 60 * 60_000],
  ['minute', 60_000],
];

/** "5 minutes ago", "yesterday", "3 weeks ago", in the UI's language. Under a minute: "now". */
export function recentWhen(usedAt: number, now: number, locale: string): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const ago = Math.max(0, now - usedAt);
  // Whole days by the calendar, so something from last night is "yesterday", not "10 hours ago".
  if (ago >= 12 * 60 * 60_000 && ago < 7 * 24 * 60 * 60_000) {
    const day = (time: number) => {
      const date = new Date(time);
      return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / (24 * 60 * 60_000);
    };
    const days = day(now) - day(usedAt);
    if (days >= 1) return format.format(-days, 'day');
  }
  for (const [unit, size] of UNITS) {
    if (ago >= size) return format.format(-Math.floor(ago / size), unit);
  }
  return format.format(0, 'second');
}
