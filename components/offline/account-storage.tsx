'use client';

import { useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Lock } from '@/components/icons';
import { SettingItem, Select, ToggleSwitch } from '@/components/settings/settings-section';
import { OrgLockedNote } from '@/components/settings/org-locked-note';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { formatFileSize } from '@/lib/utils';
import { chooseScope, clearAccount, disableOffline, dismissEvicted, enableOffline, scopeForAccount } from '@/lib/offline/offline-mode';
import { attachmentCapOptions, maxAttachmentMb, windowOptions } from '@/lib/offline/scope';
import { useOfflineStore } from '@/lib/offline/state';
import { minutesLeft, progressWorthShowing, type SyncProgress } from '@/lib/offline/sync-progress';
import { devicesForAccount } from '@/lib/device-policy';
import { KeptFiles } from './kept-files';

const MB = 1024 * 1024;
const ALL = 'all';

function ProgressLine({ progress }: { progress: SyncProgress }) {
  const t = useTranslations('offlineStorage');
  const format = useFormatter();
  const phase = progress.phase === 'list' ? t('progress_list')
    : progress.phase === 'bodies' ? t('progress_bodies')
      : progress.phase === 'threads' ? t('progress_threads')
        : progress.area === 'files' ? t('progress_files')
          : t('progress_other');
  const left = minutesLeft(progress);
  const count = progress.total === null
    ? t('progress_count_open', { done: format.number(progress.done) })
    : t('progress_count', { done: format.number(progress.done), total: format.number(progress.total) });
  return (
    <div className="space-y-1" data-testid="offline-progress">
      <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
        {phase}: {count}{left !== null && <> · {t('progress_left', { minutes: left })}</>}
      </p>
      {progress.total !== null && progress.total > 0 && (
        <progress className="h-1 w-full overflow-hidden rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary" value={Math.min(progress.done, progress.total)} max={progress.total} aria-label={phase} />
      )}
    </div>
  );
}

/** One account in Settings > Backup & reset > Offline. */
export function AccountStorage({ account, primary, heading }: { account: string; primary: boolean; heading: string | null }) {
  const t = useTranslations('offline.settings');
  const tStorage = useTranslations('offlineStorage');
  const format = useFormatter();
  const enabled = useOfflineStore((s) => s.enabled.includes(account));
  const usage = useOfflineStore((s) => s.usage[account]);
  const syncing = useOfflineStore((s) => s.syncing.includes(account));
  const lastSynced = useOfflineStore((s) => s.lastSyncedAt[account] ?? s.health[account]?.lastSync);
  const evicted = useOfflineStore((s) => s.health[account]?.evicted);
  const storageFull = useOfflineStore((s) => !!s.storageFull[account]);
  const progress = useOfflineStore((s) => s.progress[account]);
  const unsent = useOfflineStore((s) => s.outbox.filter((row) => row.account === account).length);
  // Re-renders on a choice; the value itself is worked out below, with the policy.
  useOfflineStore((s) => s.choices[account]);
  const [confirmOff, setConfirmOff] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const devices = devicesForAccount(account);
  const { scope, locked } = scopeForAccount(account);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setNow(Date.now()); }, [lastSynced, syncing]);

  const testId = (id: string) => (primary ? id : `${id}-other`);

  if (locked.offline) {
    return (
      <div className="py-3" data-testid={testId('offline-forbidden')}>
        {heading && <p className="mb-1 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{heading}</p>}
        <p className="text-sm font-medium text-foreground">{t('keep_label')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('forbidden')}</p>
        <OrgLockedNote className="mt-1" />
      </div>
    );
  }

  const windows = windowOptions(devices.offlineMaxDays);
  const windowLabel = (days: number | null) => {
    if (days === null) return tStorage('window_everything');
    if (days === 365) return tStorage('window_year');
    return tStorage('window_days', { days });
  };
  const caps = attachmentCapOptions(devices.offlineMaxAttachmentMb);
  const currentCap = maxAttachmentMb(scope);

  return (
    <div className={heading ? 'rounded-md border border-border px-3' : undefined} data-testid={testId('offline-account')}>
      {heading && <p className="pt-3 text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{heading}</p>}
      <SettingItem label={t('keep_label')} description={tStorage('keep_description')}>
        <ToggleSwitch
          checked={enabled}
          testId={testId('offline-switch')}
          onChange={(on) => {
            if (on) void enableOffline(account);
            else if (unsent > 0) setConfirmOff(true);
            else void disableOffline(account);
          }}
        />
      </SettingItem>
      {evicted && (
        <div className="my-2 flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200 sm:flex-row sm:items-center sm:justify-between" role="alert" data-testid="offline-evicted">
          <p className="min-w-0">
            {tStorage('evicted')}
            {evicted.lost > 0 && <> {tStorage('evicted_lost', { count: evicted.lost })}</>}
          </p>
          <Button variant="outline" size="sm" className="shrink-0" onClick={() => dismissEvicted(account)}>{tStorage('evicted_dismiss')}</Button>
        </div>
      )}
      {enabled && (
        <>
          {storageFull && (
            <div className="my-2 flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-foreground sm:flex-row sm:items-center sm:justify-between" role="alert" data-testid="offline-storage-full">
              <p className="min-w-0"><span className="font-medium">{tStorage('storage_full_title')}</span> {tStorage('storage_full_text')}</p>
              <Button variant="outline" size="sm" className="shrink-0" onClick={() => setConfirmClear(true)}>{tStorage('clear_button')}</Button>
            </div>
          )}
          <div className="space-y-2 py-3">
            <p className="text-xs text-muted-foreground" role="status" aria-live="polite" data-testid={testId('offline-status')}>
              {syncing
                ? t('syncing')
                : lastSynced
                  ? t('usage_updated', { size: formatFileSize(usage?.bytes ?? 0), time: format.relativeTime(lastSynced, now) })
                  : t('usage', { size: formatFileSize(usage?.bytes ?? 0) })}
            </p>
            {syncing && progressWorthShowing(progress) && <ProgressLine progress={progress} />}
            {usage && usage.parts.length > 0 && (
              <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs" data-testid={testId('offline-usage')}>
                {usage.parts.map((part) => (
                  <div key={part.part} className="contents" data-part={part.part}>
                    <dt className="min-w-0 text-muted-foreground">{tStorage(`usage_${part.part}`)}</dt>
                    <dd className="text-end tabular-nums text-foreground">{tStorage('usage_row', { size: formatFileSize(part.bytes), count: part.items })}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <SettingItem label={tStorage('window_label')} description={tStorage('window_description')} locked={windows.length <= 1}>
            <div className="flex flex-col items-start gap-1 sm:items-end">
              <Select
                value={scope.days === null ? ALL : String(scope.days)}
                onChange={(value) => chooseScope(account, { days: value === ALL ? null : Number(value) })}
                options={windows.map((days) => ({ value: days === null ? ALL : String(days), label: windowLabel(days) }))}
              />
              {locked.days && windows.length > 1 && <OrgLockedNote />}
            </div>
          </SettingItem>
          <SettingItem
            label={tStorage('attachments_label')}
            description={tStorage('attachments_description', { total: formatFileSize(scope.maxTotalBytes) })}
            locked={locked.attachments}
          >
            <ToggleSwitch
              checked={scope.attachments}
              testId={testId('offline-attachments')}
              onChange={(on) => chooseScope(account, { attachments: on })}
            />
          </SettingItem>
          {locked.maxTotal && !locked.attachments && (
            <p className="flex items-center gap-1 pb-2 text-xs text-muted-foreground" data-testid={testId('offline-total-locked')}>
              <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
              {tStorage('total_locked', { size: formatFileSize(scope.maxTotalBytes) })}
            </p>
          )}
          {scope.attachments && (
            <SettingItem label={tStorage('attachment_cap_label')} nested locked={caps.length <= 1}>
              <div className="flex flex-col items-start gap-1 sm:items-end">
                <Select
                  value={String(currentCap)}
                  onChange={(value) => chooseScope(account, { maxAttachmentMb: Number(value) })}
                  options={(caps.includes(currentCap) ? caps : [...caps, currentCap].sort((a, b) => a - b)).map((mb) => ({ value: String(mb), label: formatFileSize(mb * MB) }))}
                />
                {locked.maxAttachment && caps.length > 1 && <OrgLockedNote />}
              </div>
            </SettingItem>
          )}
          <KeptFiles account={account} />
          <SettingItem label={tStorage('clear_label')} description={tStorage('clear_description')}>
            <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)} data-testid={testId('offline-clear')}>{tStorage('clear_button')}</Button>
          </SettingItem>
        </>
      )}
      <ConfirmDialog
        isOpen={confirmOff}
        onClose={() => setConfirmOff(false)}
        onConfirm={() => { setConfirmOff(false); void disableOffline(account); }}
        title={t('off_confirm_title')}
        message={t('off_confirm_message', { count: unsent })}
        confirmText={t('off_confirm')}
        variant="destructive"
      />
      <ConfirmDialog
        isOpen={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => { setConfirmClear(false); void clearAccount(account); }}
        title={tStorage('clear_confirm_title')}
        message={unsent > 0 ? `${tStorage('clear_confirm_message')} ${tStorage('clear_confirm_unsent', { count: unsent })}` : tStorage('clear_confirm_message')}
        confirmText={tStorage('clear_confirm')}
        variant="destructive"
      />
    </div>
  );
}
