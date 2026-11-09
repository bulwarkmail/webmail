import { create } from 'zustand';
import type { Email } from '@/lib/jmap/types';

/**
 * The "Report phishing?" question waiting for an answer. Any menu or
 * toolbar asks through `requestPhishingReport`; the one host mounted in the
 * app layout (components/email/phishing-report-host.tsx) shows the dialog,
 * sends the reports and shows the outcome.
 */
interface PhishingReportState {
  /** The messages and every address their reports go to (one per account policy). */
  pending: { emails: Email[]; addresses: string[] } | null;
  /** The reports are on their way; the dialog stays open and can't be sent twice. */
  busy: boolean;
  /** Where the focus goes back to when the dialog closes. */
  opener: HTMLElement | null;
  /**
   * Messages reported in this session (emailKeyFor), so every open view
   * of them (a Pro tab, a conversation) shows the banner and turns its
   * links off at once, before the server's $phishing reaches it.
   */
  reported: Record<string, true>;
  ask: (emails: Email[], addresses: string[]) => void;
  close: () => void;
  setBusy: (busy: boolean) => void;
  markReported: (keys: string[], reported: boolean) => void;
}

/**
 * The control to give the focus back to. A menu item unmounts when the
 * menu closes: then the button that opened the menu, else none (the
 * page's focus rescue takes over).
 */
function openerOf(active: Element | null): HTMLElement | null {
  if (!(active instanceof HTMLElement)) return null;
  if (!active.closest('[role="menu"], [role="menubar"]')) return active;
  return document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"], [aria-haspopup="true"][aria-expanded="true"]');
}

export const usePhishingReportStore = create<PhishingReportState>()((set, get) => ({
  pending: null,
  busy: false,
  opener: null,
  reported: {},
  ask: (emails, addresses) => {
    if (get().busy || emails.length === 0) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    set({ pending: { emails, addresses }, opener: openerOf(active) });
  },
  close: () => {
    const { opener } = get();
    set({ pending: null, busy: false, opener: null });
    if (opener?.isConnected) opener.focus();
  },
  setBusy: (busy) => set({ busy }),
  markReported: (keys, reported) => set((state) => {
    const next = { ...state.reported };
    for (const key of keys) {
      if (reported) next[key] = true;
      else delete next[key];
    }
    return { reported: next };
  }),
}));
