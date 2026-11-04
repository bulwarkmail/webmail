import { create } from 'zustand';

/**
 * A quick reply whose send was undone, waiting for the reader of the message
 * it answers to take its text back into the quick reply box (mail-p2-8).
 */
interface QuickReplyRestoreState {
  pending: { emailId: string; text: string } | null;
  restore: (emailId: string, text: string) => void;
  /** The reader of `emailId` takes the text; null when none waits for it. */
  take: (emailId: string) => string | null;
}

export const useQuickReplyRestoreStore = create<QuickReplyRestoreState>()((set, get) => ({
  pending: null,
  restore: (emailId, text) => set({ pending: { emailId, text } }),
  take: (emailId) => {
    const pending = get().pending;
    if (!pending || pending.emailId !== emailId) return null;
    set({ pending: null });
    return pending.text;
  },
}));
