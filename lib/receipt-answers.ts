import { create } from 'zustand';
import { onFullSignOut } from '@/lib/sign-out-cleanup';

/**
 * Messages whose Authentication-Results were found written on receipt when
 * they were shown in full (authenticationResultsEvidence in
 * lib/email-headers.ts). A list row is fetched without what that check needs,
 * so it shows a sender logo only for a message remembered here. A message is
 * named by its blob id and size: the answer depends on the message's own
 * headers, which a blob id stands for, so a row can only borrow the answer of
 * the very message that was checked. Only "yes" is kept; a row of a message
 * that failed the check, or was never opened, has nothing to borrow. Kept in
 * this browser across reloads, and forgotten when everyone signs out.
 */

const STORAGE_KEY = 'bulwark-receipt-checked';
/** The most recent answers kept; older ones go first. */
const MAX_KEPT = 2000;

/** The name of a message's answer, or null when the message has no blob id. */
export function receiptAnswerKey(email: { blobId?: string | null; size?: number | null } | null | undefined): string | null {
  const blobId = email?.blobId;
  if (typeof blobId !== 'string' || blobId === '') return null;
  return `${blobId}|${typeof email?.size === 'number' ? email.size : ''}`;
}

function readStored(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((key): key is string => typeof key === 'string').slice(-MAX_KEPT) : [];
  } catch {
    return [];
  }
}

function writeStored(keys: string[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Another tab may have remembered messages since this one loaded.
    const merged = [...new Set([...readStored(), ...keys])].slice(-MAX_KEPT);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* storage unavailable or full: the answer lasts this page only */
  }
}

interface ReceiptAnswersState {
  known: ReadonlySet<string>;
  remember: (key: string) => void;
  reset: () => void;
}

export const useReceiptAnswers = create<ReceiptAnswersState>()((set, get) => ({
  known: new Set(readStored()),
  remember: (key) => {
    if (get().known.has(key)) return;
    const next = [...get().known, key].slice(-MAX_KEPT);
    set({ known: new Set(next) });
    writeStored(next);
  },
  reset: () => {
    set({ known: new Set() });
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
  },
}));

// Nobody signed in any more: nothing of the accounts' mail stays named here.
onFullSignOut(() => useReceiptAnswers.getState().reset());
