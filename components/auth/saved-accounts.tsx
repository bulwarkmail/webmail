"use client";

import { useTranslations } from 'next-intl';
import { X } from '@/components/icons';
import { toUnicodeEmail } from '@/lib/idn';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useAccountListPreferencesStore } from '@/stores/account-list-preferences-store';

/** Offer retained accounts without reviving their sessions. / 저장된 계정을 표시하고 선택 시 재인증을 요청합니다. */
export function SavedAccounts() {
  const t = useTranslations('sidebar');
  const login = useTranslations('login');
  const accounts = useAccountStore((state) => state.accounts);
  const remember = useAccountListPreferencesStore((state) => state.rememberAccountList === true);
  const switchAccount = useAuthStore((state) => state.switchAccount);
  const removeAccount = useAuthStore((state) => state.removeAccount);
  const saved = accounts.filter((account) => account.awaitingSignIn);
  if (!remember || saved.length === 0) return null;

  return (
    <section className="mb-5 space-y-2" aria-label={t('switch_account')}>
      <p className="text-sm font-medium text-muted-foreground">{t('switch_account')}</p>
      <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border">
        {saved.map((account) => (
          <div key={account.id} className="flex items-center">
            <button
              type="button"
              onClick={() => { void switchAccount(account.id); }}
              className="flex min-w-0 flex-1 items-center justify-between gap-3 p-3 text-start hover:bg-muted"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{toUnicodeEmail(account.displayName || account.label)}</span>
                <span className="block truncate text-xs text-muted-foreground">{toUnicodeEmail(account.email || account.username)}</span>
                <span className="block truncate text-xs text-muted-foreground">{account.serverUrl}</span>
              </span>
              <span className="shrink-0 text-xs text-primary">{login('sign_in')}</span>
            </button>
            <button
              type="button"
              aria-label={`${t('remove_account')}: ${toUnicodeEmail(account.email || account.username)}`}
              onClick={() => {
                if (window.confirm(t('remove_account_confirm', { account: toUnicodeEmail(account.email || account.username) }))) {
                  removeAccount(account.id);
                }
              }}
              className="me-2 rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
