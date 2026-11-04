'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from '@/components/icons';
import { SettingsSection } from '@/components/settings/settings-section';
import { Button } from '@/components/ui/button';
import { IS_LITE } from '@/lib/lite';
import { isDesktopApp } from '@/lib/desktop/bridge';
import { signedInAccountIds } from '@/lib/device-policy';
import { offlineAllowed, offlineSupported, readPersistence, refreshUsage, requestPersistence, safariMayDelete } from '@/lib/offline/offline-mode';
import { useOfflineStore } from '@/lib/offline/state';
import { useDevicePolicy } from '@/hooks/use-device-policy';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { AccountStorage } from './account-storage';
import { OutboxList } from './outbox-list';
import { KeyProtectionNotes } from './key-protection-notes';
import { WipeDeviceSection } from './wipe-device-section';

/**
 * Settings > Backup & reset > Offline (#523): for each account signed in here,
 * whether it keeps mail on this device, how much, what that takes, and the way
 * to clear it. Above that what the browser may do to it, below it the outbox
 * and whatever didn't go through. Not in Lite.
 */
export function OfflineSettings() {
  const t = useTranslations('offline.settings');
  const tStorage = useTranslations('offlineStorage');
  const active = useAuthStore((s) => s.activeAccountId);
  useAuthStore((s) => s.connectedAccountsRevision);
  // Re-renders when the organisation's device settings change.
  useDevicePolicy();
  const labels = useAccountStore((s) => s.accounts);
  const enabledCount = useOfflineStore((s) => s.enabled.length);
  const persist = useOfflineStore((s) => s.persist);
  const blocked = useOfflineStore((s) => s.storageBlocked);
  const tNotes = useTranslations('offlineConflicts');
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    if (IS_LITE || enabledCount === 0) return;
    void readPersistence();
    void refreshUsage();
  }, [enabledCount]);

  if (IS_LITE) return null;

  const accounts = [...new Set([...(active ? [active] : []), ...signedInAccountIds()])];
  const several = accounts.length > 1;
  const askAgain = async () => {
    setAsking(true);
    await requestPersistence();
    setAsking(false);
  };

  return (
    <SettingsSection id="offline" title={t('title')} description={t('description')}>
      {blocked ? (
        <p className="text-sm text-muted-foreground" data-testid="offline-private">{tNotes('store_private')}</p>
      ) : !offlineSupported() ? (
        <p className="text-sm text-muted-foreground" data-testid="offline-unsupported">{t('unsupported')}</p>
      ) : (
        <>
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <p data-testid="offline-warning">{isDesktopApp() ? tStorage('warning_desktop') : t('warning')}</p>
          </div>
          <KeyProtectionNotes browser />
          {enabledCount > 0 && persist === 'refused' && (
            <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between" role="status" data-testid="offline-persist-refused">
              <p className="min-w-0">{tStorage('persist_refused')}</p>
              <Button variant="outline" size="sm" className="shrink-0" disabled={asking} onClick={() => void askAgain()} data-testid="offline-persist-retry">{tStorage('persist_retry')}</Button>
            </div>
          )}
          {enabledCount > 0 && safariMayDelete() && (
            <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground" data-testid="offline-safari-hint">{tStorage('safari_hint')}</p>
          )}
          {accounts.map((account, index) => (
            <AccountStorage
              key={account}
              account={account}
              primary={index === 0}
              heading={several ? labels.find((entry) => entry.id === account)?.email || labels.find((entry) => entry.id === account)?.label || account : null}
            />
          ))}
          {[active, ...accounts].some((account) => offlineAllowed(account)) && <WipeDeviceSection />}
        </>
      )}
      <OutboxList />
    </SettingsSection>
  );
}
