'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle } from '@/components/icons';
import { SettingItem, SettingsSection, ToggleSwitch } from '@/components/settings/settings-section';
import { OrgLockedNote } from '@/components/settings/org-locked-note';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { IS_LITE } from '@/lib/lite';
import { formatFileSize } from '@/lib/utils';
import { disableOffline, enableOffline, offlineAllowed, offlineSupported } from '@/lib/offline/offline-mode';
import { useOfflineStore } from '@/lib/offline/state';
import { useDevicePolicy } from '@/hooks/use-device-policy';
import { useAuthStore } from '@/stores/auth-store';
import { OutboxList } from './outbox-list';

/**
 * Settings > Backup & reset > Offline (#523): "Keep mail on this device"
 * for the active account, the space it uses, and the outbox. Not in Lite.
 * When the organisation forbids it, the switch is gone and a note says so.
 */
export function OfflineSettings() {
  const t = useTranslations('offline.settings');
  const format = useFormatter();
  const account = useAuthStore((s) => s.activeAccountId);
  // Re-renders when the organisation's device settings change.
  const devices = useDevicePolicy();
  const enabled = useOfflineStore((s) => !!account && s.enabled.includes(account));
  const usage = useOfflineStore((s) => s.usageBytes);
  const syncing = useOfflineStore((s) => !!account && s.syncing.includes(account));
  const lastSynced = useOfflineStore((s) => (account ? s.lastSyncedAt[account] : undefined));
  const unsent = useOfflineStore((s) => s.outbox.filter((row) => row.account === account).length);
  const [confirmOff, setConfirmOff] = useState(false);

  if (IS_LITE) return null;
  const allowed = !devices.noOffline && offlineAllowed(account);

  const turnOff = () => {
    if (!account) return;
    void disableOffline(account);
  };

  return (
    <SettingsSection id="offline" title={t('title')} description={t('description')}>
      {!offlineSupported() ? (
        <p className="text-sm text-muted-foreground" data-testid="offline-unsupported">{t('unsupported')}</p>
      ) : !allowed ? (
        <div className="py-3" data-testid="offline-forbidden">
          <p className="text-sm font-medium text-foreground">{t('keep_label')}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('forbidden')}</p>
          <OrgLockedNote className="mt-1" />
        </div>
      ) : (
        <>
          <SettingItem label={t('keep_label')} description={t('keep_description')}>
            <ToggleSwitch
              checked={enabled}
              testId="offline-switch"
              onChange={(on) => {
                if (!account) return;
                if (on) void enableOffline(account);
                else if (unsent > 0) setConfirmOff(true);
                else turnOff();
              }}
            />
          </SettingItem>
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <p>{t('warning')}</p>
          </div>
          {enabled && (
            <p className="text-xs text-muted-foreground" role="status" aria-live="polite" data-testid="offline-status">
              {syncing
                ? t('syncing')
                : lastSynced
                  ? t('usage_updated', { size: formatFileSize(usage), time: format.relativeTime(lastSynced, Date.now()) })
                  : t('usage', { size: formatFileSize(usage) })}
            </p>
          )}
        </>
      )}
      <OutboxList />
      <ConfirmDialog
        isOpen={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => { setConfirmOff(false); turnOff(); }}
        title={t('off_confirm_title')}
        message={t('off_confirm_message', { count: unsent })}
        confirmText={t('off_confirm')}
        variant="destructive"
      />
    </SettingsSection>
  );
}
