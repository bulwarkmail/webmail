/**
 * What the reminder code shares across the page, kept free of the rest of the app so
 * useCalendarAlerts can read it without pulling in the local store.
 */

import { create } from 'zustand';
import type { ReminderAlert } from '@/lib/store/reminders/ledger';

interface ReminderSourceState {
  /** Local accounts whose reminders come from the store: useCalendarAlerts leaves those alone. */
  driven: Record<string, true>;
  setDriven: (account: string, driven: boolean) => void;
}

export const useReminderSource = create<ReminderSourceState>()((set) => ({
  driven: {},
  setDriven: (account, driven) => set((state) => {
    if (!!state.driven[account] === driven) return state;
    const next = { ...state.driven };
    if (driven) next[account] = true;
    else delete next[account];
    return { driven: next };
  }),
}));

interface MissedRemindersState {
  account: string | null;
  alerts: ReminderAlert[];
  show: (account: string, alerts: ReminderAlert[]) => void;
  close: () => void;
}

/** The summary dialog's contents. Empty: it's closed. */
export const useMissedReminders = create<MissedRemindersState>()((set) => ({
  account: null,
  alerts: [],
  show: (account, alerts) => set({ account, alerts }),
  close: () => set({ account: null, alerts: [] }),
}));

let poke: (() => void) | null = null;

/** The running check, so something done from a toast takes effect at once. */
export function setReminderPoke(next: (() => void) | null): void {
  poke = next;
}

export function pokeReminders(): void {
  poke?.();
}

/** The zone that reads a floating event: the setting's, or the system's on `auto`. */
export function reminderTimeZone(setting: string | undefined): string {
  return setting && setting !== 'auto' ? setting : Intl.DateTimeFormat().resolvedOptions().timeZone;
}
