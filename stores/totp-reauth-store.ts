import { create } from 'zustand';

/**
 * Global store for TOTP re-authentication prompts.
 *
 * When a JMAP client detects a 401 and TOTP was used for login,
 * it calls the registered callback which triggers this store to show
 * a dialog. The dialog collects a fresh TOTP code and resolves the
 * pending promise so the client can retry with updated credentials.
 */

interface TotpReauthState {
  isOpen: boolean;
  resolve: ((totp: string | null) => void) | null;
  /** Request a fresh TOTP code from the user. Returns the code or null if cancelled. */
  requestTotp: () => Promise<string | null>;
  /** Submit the TOTP code from the dialog. */
  submit: (totp: string) => void;
  /** Cancel/dismiss the dialog. */
  cancel: () => void;
}

export const useTotpReauthStore = create<TotpReauthState>()((set, get) => ({
  isOpen: false,
  resolve: null,

  requestTotp: () => {
    // If already open, cancel the previous request
    const prev = get().resolve;
    if (prev) prev(null);

    return new Promise<string | null>((resolve) => {
      set({ isOpen: true, resolve });
    });
  },

  submit: (totp: string) => {
    const { resolve } = get();
    if (resolve) resolve(totp);
    set({ isOpen: false, resolve: null });
  },

  cancel: () => {
    const { resolve } = get();
    if (resolve) resolve(null);
    set({ isOpen: false, resolve: null });
  },
}));
