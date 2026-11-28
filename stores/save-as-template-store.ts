import { create } from 'zustand';
import type { Email } from '@/lib/jmap/types';

/**
 * "Save as template" asked on a message. Any menu asks through `ask`; the
 * one host mounted in the app layout (components/templates/save-as-template-host.tsx)
 * reads the message and shows the dialog.
 */
interface SaveAsTemplateState {
  /** The message, and a number that tells two requests for the same message apart. */
  pending: { email: Email; request: number } | null;
  ask: (email: Email) => void;
  close: () => void;
}

let requests = 0;

export const useSaveAsTemplateStore = create<SaveAsTemplateState>()((set) => ({
  pending: null,
  ask: (email) => set({ pending: { email, request: ++requests } }),
  close: () => set({ pending: null }),
}));
