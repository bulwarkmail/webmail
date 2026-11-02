'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteOutboxEntry, retryOutboxEntry } from '@/lib/offline/flush';
import { refreshQueueState, scheduleFlushAll } from '@/lib/offline/offline-mode';
import { isOfflineNow, useOfflineStore, type OutboxRow } from '@/lib/offline/state';
import { useAccountStore } from '@/stores/account-store';

/**
 * The offline outbox (#523): messages written offline that wait for the
 * network, with what happened to them. A message that couldn't be sent can
 * be sent again or deleted; one whose connection broke on the way is never
 * sent again on its own (it may have gone out); one held because the
 * organisation's rules changed can only be deleted (and written again).
 */
export function OutboxList({ heading = true }: { heading?: boolean }) {
  const t = useTranslations('offline.outbox');
  const tErrors = useTranslations('offline.errors');
  const format = useFormatter();
  const rows = useOfflineStore((s) => s.outbox);
  const changes = useOfflineStore((s) => s.pendingChanges);
  const accounts = useAccountStore((s) => s.accounts);
  const [deleting, setDeleting] = useState<OutboxRow | null>(null);
  const several = new Set(rows.map((r) => r.account)).size > 1 || accounts.length > 1;

  const status = (row: OutboxRow) => {
    switch (row.status) {
      case 'sending': return t('status_sending');
      case 'failed': return t('status_failed', { error: row.error?.code ? tErrors(row.error.code) : (row.error?.text ?? '') });
      case 'uncertain': return t('status_uncertain');
      case 'held': return t('status_held');
      default: return t('status_waiting');
    }
  };

  const retry = async (row: OutboxRow) => {
    await retryOutboxEntry(row.id);
    await refreshQueueState();
    if (!isOfflineNow()) scheduleFlushAll(0);
  };

  return (
    <div className={heading ? 'pt-2' : undefined} data-testid="offline-outbox">
      {heading && <h4 className="text-sm font-medium text-foreground">{t('title')}</h4>}
      <p className="mt-1 text-xs text-muted-foreground">{t('description')}</p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground" data-testid="offline-outbox-empty">{t('empty')}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border" aria-label={t('title')}>
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between" data-testid="offline-outbox-row" data-status={row.status}>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{row.subject || t('no_subject')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t('to', { recipients: row.to.join(', ') })}
                  {several && <> · {accounts.find((a) => a.id === row.account)?.label ?? row.account}</>}
                </p>
                <p className={row.status === 'failed' || row.status === 'uncertain' || row.status === 'held' ? 'text-xs text-destructive [overflow-wrap:anywhere]' : 'text-xs text-muted-foreground'}>
                  {status(row)} · {format.dateTime(row.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                {(row.status === 'failed' || row.status === 'uncertain') && (
                  <Button variant="outline" size="sm" aria-label={t('retry_label', { subject: row.subject || t('no_subject') })} onClick={() => void retry(row)}>{t('retry')}</Button>
                )}
                {row.status !== 'sending' && (
                  <Button variant="outline" size="sm" aria-label={t('delete_label', { subject: row.subject || t('no_subject') })} onClick={() => setDeleting(row)}>{t('delete')}</Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {changes > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="offline-pending-changes">{t('changes', { count: changes })}</p>
      )}
      <ConfirmDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row) void deleteOutboxEntry(row.id).then(refreshQueueState);
        }}
        title={t('delete_confirm_title')}
        message={t('delete_confirm_message')}
        confirmText={t('delete')}
        variant="destructive"
      />
    </div>
  );
}
