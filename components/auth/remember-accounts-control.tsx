"use client";

import { useTranslations } from 'next-intl';
import { useAccountListPreferencesStore } from '@/stores/account-list-preferences-store';

/** Let this device choose whether signed-out accounts remain listed. / 로그아웃된 계정을 이 기기에 남길지 사용자가 선택합니다. */
export function RememberAccountsControl() {
  const t = useTranslations('login');
  const remember = useAccountListPreferencesStore((state) => state.rememberAccountList === true);
  const setRemember = useAccountListPreferencesStore((state) => state.setRememberAccountList);

  return (
    <label className="mb-5 flex cursor-pointer items-start gap-3 text-sm">
      <input
        type="checkbox"
        checked={remember}
        onChange={(event) => setRemember(event.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 accent-primary"
      />
      <span>
        <span className="block font-medium">{t('remember_accounts')}</span>
        <span className="block text-xs text-muted-foreground">{t('remember_accounts_hint')}</span>
      </span>
    </label>
  );
}
