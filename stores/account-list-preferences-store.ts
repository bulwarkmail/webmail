import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useAccountStore } from './account-store';

type AccountListPreferences = {
  rememberAccountList: boolean | null;
  /** Adopt the deployment default once, preserving this device's choice. / 기기 선택이 없을 때만 배포 기본값을 적용합니다. */
  initialize: (defaultEnabled: boolean) => void;
  /** Change this device's choice and forget signed-out names when disabled. / 기기별 선택을 바꾸고 해제하면 로그아웃된 계정명을 지웁니다. */
  setRememberAccountList: (enabled: boolean) => void;
};

export const useAccountListPreferencesStore = create<AccountListPreferences>()(
  persist(
    (set, get) => ({
      rememberAccountList: null,
      /** A local choice takes precedence over the deployment default. / 기기의 명시적 선택을 배포 기본값보다 우선합니다. */
      initialize: (defaultEnabled) => {
        if (get().rememberAccountList !== null) return;
        set({ rememberAccountList: defaultEnabled });
      },
      /** Keep this preference local; opting out forgets only signed-out entries. / 설정은 기기에만 보관하며 해제 시 재로그인 대기 항목만 정리합니다. */
      setRememberAccountList: (enabled) => {
        set({ rememberAccountList: enabled });
        if (enabled) return;
        const accounts = useAccountStore.getState();
        for (const account of accounts.accounts) {
          if (account.awaitingSignIn) accounts.removeAccount(account.id);
        }
      },
    }),
    {
      name: 'account-list-preferences',
      partialize: (state) => ({ rememberAccountList: state.rememberAccountList }),
      // Corrupt storage must not turn an opt-in privacy choice on. / 잘못 저장된 값으로 계정 기억 기능을 켜지 않습니다.
      merge: (persisted, current) => {
        const saved = persisted as Partial<AccountListPreferences> | undefined;
        let rememberAccountList: boolean | null = null;
        if (typeof saved?.rememberAccountList === 'boolean') rememberAccountList = saved.rememberAccountList;
        return { ...current, rememberAccountList };
      },
    },
  ),
);
