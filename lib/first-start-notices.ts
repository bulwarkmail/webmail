/**
 * Notices for a first start: what the app did by itself (keeping mail on this device),
 * or a question it has to ask once (a spelling dictionary). They show one at a time, in
 * a bar above the message list (components/ui/first-start-notice.tsx), so they never
 * cover the composer, a toolbar or the window's controls the way a floating toast did.
 * Each has a close button, and once closed, by the X or its button, it doesn't come
 * back on this device.
 */

import { create } from 'zustand';

export interface FirstStartNotice {
  id: string;
  text: string;
  action?: { label: string; onClick: () => void };
  /** Where "closed" is kept. Defaults to one key per id. */
  doneKey?: string;
  /** Runs when the user closes it, by the X or the action. */
  onClose?: () => void;
}

interface NoticeState {
  queue: FirstStartNotice[];
}

const useNotices = create<NoticeState>(() => ({ queue: [] }));

function doneKeyOf(notice: Pick<FirstStartNotice, 'id' | 'doneKey'>): string {
  return notice.doneKey ?? `bulwark-notice-done:${notice.id}`;
}

function isDone(notice: Pick<FirstStartNotice, 'id' | 'doneKey'>): boolean {
  try {
    return localStorage.getItem(doneKeyOf(notice)) !== null;
  } catch {
    return false;
  }
}

/** Queues a notice. One closed before, or already waiting, is left out. */
export function showFirstStartNotice(notice: FirstStartNotice): void {
  if (isDone(notice)) return;
  if (useNotices.getState().queue.some((waiting) => waiting.id === notice.id)) return;
  useNotices.setState((state) => ({ queue: [...state.queue, notice] }));
}

/** The user closed it: gone for good on this device, and the next one shows. */
export function closeFirstStartNotice(id: string): void {
  const notice = useNotices.getState().queue.find((waiting) => waiting.id === id);
  if (!notice) return;
  try {
    localStorage.setItem(doneKeyOf(notice), '1');
  } catch {
    // Private mode: it goes for this session.
  }
  useNotices.setState((state) => ({ queue: state.queue.filter((waiting) => waiting.id !== id) }));
  try {
    notice.onClose?.();
  } catch {
    // A failing listener must not keep the notice on screen.
  }
}

/** Takes a waiting notice away without marking it closed, e.g. when what it asks no longer applies. */
export function withdrawFirstStartNotice(id: string): void {
  useNotices.setState((state) => ({ queue: state.queue.filter((waiting) => waiting.id !== id) }));
}

/** The one notice to show now, if any. */
export function useCurrentFirstStartNotice(): FirstStartNotice | null {
  return useNotices((state) => state.queue[0] ?? null);
}

export function firstStartNoticesWaiting(): FirstStartNotice[] {
  return useNotices.getState().queue;
}

/** Test helper. */
export function resetFirstStartNotices(): void {
  useNotices.setState({ queue: [] });
}
