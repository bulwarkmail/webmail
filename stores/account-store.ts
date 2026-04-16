import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { generateAccountId, generateAvatarColor, MAX_ACCOUNTS } from '@/lib/account-utils';

export interface AccountEntry {
  /** Unique key: `${username}@${serverHostname}` */
  id: string;
  /** Display label (defaults to email, user-editable) */
  label: string;
  /** Full server URL */
  serverUrl: string;
  /** Username / email used to authenticate */
  username: string;
  /** Authentication mode */
  authMode: 'basic' | 'oauth';
  /** Cookie slot index (0–4) for session/token cookies */
  cookieSlot: number;
  /** Whether "Remember Me" was checked (basic auth only) */
  rememberMe: boolean;
  /** Cached display info */
  displayName: string;
  email: string;
  avatarColor: string;
  /** Timestamp of last successful login */
  lastLoginAt: number;
  /** Whether this account is currently connected */
  isConnected: boolean;
  /** Whether this account had a connection error */
  hasError: boolean;
  errorMessage?: string;
  /** Whether this is the default account (loaded on app start) */
  isDefault: boolean;
}

interface AccountState {
  accounts: AccountEntry[];
  activeAccountId: string | null;
  defaultAccountId: string | null;

  addAccount: (entry: Omit<AccountEntry, 'id' | 'cookieSlot' | 'avatarColor'>) => string;
  removeAccount: (accountId: string) => void;
  setActiveAccount: (accountId: string) => void;
  setDefaultAccount: (accountId: string) => void;
  getDefaultAccount: () => AccountEntry | null;
  updateAccount: (accountId: string, updates: Partial<AccountEntry>) => void;
  getActiveAccount: () => AccountEntry | null;
  getAccountById: (accountId: string) => AccountEntry | undefined;
  getNextCookieSlot: () => number;
  hasAccount: (username: string, serverUrl: string) => boolean;
}

export const useAccountStore = create<AccountState>()(
  persist(
    (set, get) => ({
      accounts: [],
      activeAccountId: null,
      defaultAccountId: null,

      addAccount: (entry) => {
        const state = get();

        const id = generateAccountId(entry.username, entry.serverUrl);
        if (state.accounts.some((a) => a.id === id)) {
          // Already exists - update mutable fields and return existing id
          set((s) => ({
            accounts: s.accounts.map((a) =>
              a.id === id
                ? {
                    ...a,
                    rememberMe: entry.rememberMe,
                    isConnected: entry.isConnected,
                    hasError: entry.hasError,
                    errorMessage: undefined,
                    lastLoginAt: entry.lastLoginAt,
                    authMode: entry.authMode,
                  }
                : a
            ),
          }));
          return id;
        }

        if (state.accounts.length >= MAX_ACCOUNTS) {
          throw new Error(`Maximum of ${MAX_ACCOUNTS} accounts reached`);
        }

        const cookieSlot = state.getNextCookieSlot();
        const avatarColor = generateAvatarColor(entry.email || entry.username);
        const isDefault = state.accounts.length === 0; // first account is default

        const account: AccountEntry = {
          ...entry,
          id,
          cookieSlot,
          avatarColor,
          isDefault,
        };

        set((s) => ({
          accounts: [...s.accounts, account],
          // If there is no active account, activate this one
          activeAccountId: s.activeAccountId ?? id,
          defaultAccountId: isDefault ? id : s.defaultAccountId,
        }));

        return id;
      },

      removeAccount: (accountId) => {
        set((s) => {
          const remaining = s.accounts.filter((a) => a.id !== accountId);
          const wasDefault = s.defaultAccountId === accountId;
          const wasActive = s.activeAccountId === accountId;

          let newDefault = s.defaultAccountId;
          if (wasDefault) {
            newDefault = remaining[0]?.id ?? null;
            // Mark new default
            if (newDefault) {
              const idx = remaining.findIndex((a) => a.id === newDefault);
              if (idx >= 0) {
                remaining[idx] = { ...remaining[idx], isDefault: true };
              }
            }
          }

          return {
            accounts: remaining,
            activeAccountId: wasActive ? (remaining[0]?.id ?? null) : s.activeAccountId,
            defaultAccountId: newDefault,
          };
        });
      },

      setActiveAccount: (accountId) => {
        const account = get().accounts.find((a) => a.id === accountId);
        if (!account) return;
        set({ activeAccountId: accountId });
      },

      setDefaultAccount: (accountId) => {
        const account = get().accounts.find((a) => a.id === accountId);
        if (!account) return;
        set((s) => ({
          defaultAccountId: accountId,
          accounts: s.accounts.map((a) => ({
            ...a,
            isDefault: a.id === accountId,
          })),
        }));
      },

      getDefaultAccount: () => {
        const state = get();
        if (state.defaultAccountId) {
          const account = state.accounts.find((a) => a.id === state.defaultAccountId);
          if (account) return account;
        }
        return state.accounts[0] ?? null;
      },

      updateAccount: (accountId, updates) => {
        set((s) => ({
          accounts: s.accounts.map((a) =>
            a.id === accountId ? { ...a, ...updates } : a
          ),
        }));
      },

      getActiveAccount: () => {
        const state = get();
        return state.accounts.find((a) => a.id === state.activeAccountId) ?? null;
      },

      getAccountById: (accountId) => {
        return get().accounts.find((a) => a.id === accountId);
      },

      getNextCookieSlot: () => {
        const used = new Set(get().accounts.map((a) => a.cookieSlot));
        for (let i = 0; i < MAX_ACCOUNTS; i++) {
          if (!used.has(i)) return i;
        }
        return 0; // fallback, shouldn't happen if max is enforced
      },

      hasAccount: (username, serverUrl) => {
        const id = generateAccountId(username, serverUrl);
        return get().accounts.some((a) => a.id === id);
      },
    }),
    {
      name: 'account-registry',
      partialize: (state) => ({
        accounts: state.accounts,
        activeAccountId: state.activeAccountId,
        defaultAccountId: state.defaultAccountId,
      }),
    }
  )
);
