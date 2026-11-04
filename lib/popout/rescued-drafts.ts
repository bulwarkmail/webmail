/**
 * Text from a closing pop-out that couldn't be saved. It waits here, kept over
 * a reload, until the mail view can put it in its "Continue draft" slot.
 */

import type { ComposerDraftData } from '@/components/email/email-composer';

const STORAGE_KEY = 'bulwark-rescued-drafts';

const listeners = new Set<() => void>();

function read(): ComposerDraftData[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as ComposerDraftData[]) : [];
  } catch {
    return [];
  }
}

function write(list: ComposerDraftData[]): void {
  try {
    if (list.length === 0) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Full or unavailable: it stays for as long as this page does, below.
  }
}

let memory: ComposerDraftData[] | null = null;

export function keepRescuedDraft(draft: ComposerDraftData): void {
  memory = [...(memory ?? read()), { ...draft, unsaved: true }];
  write(memory);
  for (const listener of [...listeners]) listener();
}

/** The oldest waiting draft, taken off the list; null when there is none. */
export function takeRescuedDraft(): ComposerDraftData | null {
  const list = memory ?? read();
  if (list.length === 0) return null;
  const [first, ...rest] = list;
  memory = rest;
  write(rest);
  return first;
}

/** A wipe: the text of a message nobody could save goes too. */
export function clearRescuedDrafts(): void {
  memory = [];
  write([]);
}

/** Calls `listener` when a draft comes in. Returns the unsubscribe. */
export function onRescuedDraft(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
