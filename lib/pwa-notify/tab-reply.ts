import { create } from 'zustand';

/** A tab that hasn't got the message by then has been left behind. */
const MAX_AGE_MS = 2 * 60 * 1000;

interface TabReplyState {
  pending: { emailId: string; text: string; at: number } | null;
}

/**
 * A notification's Reply in the Pro shell, where a message lives in a tab of
 * its own that fetches it. Waits here, not in the tab store: that one is kept
 * in localStorage, and a reply being typed is not for keeping.
 */
export const useNotificationTabReply = create<TabReplyState>(() => ({ pending: null }));

export function requestTabReply(emailId: string, text: string): void {
  useNotificationTabReply.setState({ pending: { emailId, text, at: Date.now() } });
}

/** The text for a reply to this message, once; null when none waits. */
export function takeTabReply(emailId: string): string | null {
  const { pending } = useNotificationTabReply.getState();
  if (!pending || pending.emailId !== emailId) return null;
  useNotificationTabReply.setState({ pending: null });
  return Date.now() - pending.at < MAX_AGE_MS ? pending.text : null;
}
