'use client';

import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { usePathname, useRouter } from '@/i18n/navigation';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteOutboxEntry, retryOutboxEntry } from '@/lib/offline/flush';
import { dismissAreaConflict, refreshQueueState, scheduleFlushAll } from '@/lib/offline/offline-mode';
import { dismissConflict, retryLocalDraft, type ConflictEntry, type LocalDraftRow } from '@/lib/offline/queue';
import { isOfflineNow, useOfflineStore, type AreaConflict, type OutboxRow } from '@/lib/offline/state';
import { useAccountStore } from '@/stores/account-store';

/**
 * The offline outbox (#523): messages written offline that wait for the
 * network, with what happened to them. A message that couldn't be sent can
 * be sent again or deleted; one whose connection broke on the way is never
 * sent again on its own (it may have gone out); one held because the
 * organisation's rules changed can only be deleted (and written again).
 * Changes that didn't go through ("changed on another device") are listed too,
 * and drafts that are only on this device: on their way up, or refused by the
 * server, in which case they can still be opened and tried again.
 */
export function OutboxList({ heading = true, onOpenDraft }: { heading?: boolean; onOpenDraft?: () => void }) {
  const t = useTranslations('offline.outbox');
  const tErrors = useTranslations('offline.errors');
  const tConflicts = useTranslations('offlineConflicts');
  const tStorage = useTranslations('offlineStorage');
  const tDrafts = useTranslations('offlineDrafts');
  const router = useRouter();
  const pathname = usePathname();
  const localDrafts = useOfflineStore((s) => s.localDrafts);
  const format = useFormatter();
  const rows = useOfflineStore((s) => s.outbox);
  const changes = useOfflineStore((s) => s.pendingChanges);
  const conflicts = useOfflineStore((s) => s.conflicts);
  const areaConflicts = useOfflineStore((s) => s.areaConflicts);
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
    await retryOutboxEntry(row.account, row.id);
    await refreshQueueState();
    if (!isOfflineNow()) scheduleFlushAll(0);
  };

  const draftStatus = (draft: LocalDraftRow) => {
    switch (draft.status) {
      case 'refused': return tDrafts('status_refused', { error: draft.error?.code ? tDrafts(draft.error.code) : (draft.error?.text ?? '') });
      case 'sending': return tDrafts('status_sending');
      case 'uncertain': return tDrafts('status_uncertain');
      default: return tDrafts('status_waiting');
    }
  };

  const openDraft = (draft: LocalDraftRow) => {
    useOfflineStore.setState({ draftToOpen: { account: draft.account, jmap: draft.jmap, id: draft.localId } });
    onOpenDraft?.();
    if (!pathname.startsWith('/mail')) router.push('/mail');
  };

  const retryDraft = async (draft: LocalDraftRow) => {
    await retryLocalDraft(draft.account, draft.localId);
    await refreshQueueState();
    if (!isOfflineNow()) scheduleFlushAll(0);
  };

  const conflictText = (conflict: ConflictEntry) => {
    if (conflict.summary.op === 'draft') return tDrafts(conflict.summary.reason === 'gone' ? 'conflict_gone' : 'conflict_changed');
    if (conflict.summary.reason === 'refused') return tConflicts('refused', { reason: conflict.summary.detail ?? '' });
    if (conflict.summary.reason === 'gone') return tConflicts('gone');
    return tConflicts(conflict.summary.op === 'destroy' ? 'changed_delete' : 'changed');
  };

  const areaConflictText = (conflict: AreaConflict) => {
    if (conflict.reason === 'refused') return tConflicts('refused', { reason: conflict.detail ?? '' });
    if (conflict.reason === 'gone') return tConflicts('gone');
    return tConflicts(conflict.destroy ? 'changed_delete' : 'changed');
  };

  const dismiss = async (conflict: ConflictEntry) => {
    await dismissConflict(conflict.account, conflict.id);
    await refreshQueueState();
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
            <li key={`${row.account}:${row.id}`} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between" data-testid="offline-outbox-row" data-status={row.status}>
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
      {localDrafts.length > 0 && (
        <div className="mt-3" data-testid="offline-local-drafts">
          <p className="text-xs text-muted-foreground">{tDrafts('description')}</p>
          <ul className="mt-2 divide-y divide-border rounded-md border border-border" aria-label={tDrafts('title')}>
            {localDrafts.map((draft) => (
              <li key={`${draft.account}:${draft.localId}`} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between" data-testid="offline-local-draft-row" data-status={draft.status}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{draft.subject || t('no_subject')}</p>
                  <p className={draft.status === 'refused' ? 'text-xs text-destructive [overflow-wrap:anywhere]' : 'text-xs text-muted-foreground'}>
                    {draftStatus(draft)} · {format.dateTime(draft.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" aria-label={tDrafts('open_label', { subject: draft.subject || t('no_subject') })} onClick={() => openDraft(draft)}>{tDrafts('open')}</Button>
                  {draft.status === 'refused' && (
                    <Button variant="outline" size="sm" aria-label={tDrafts('retry_label', { subject: draft.subject || t('no_subject') })} onClick={() => void retryDraft(draft)}>{tDrafts('retry')}</Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {changes > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="offline-pending-changes">{t('changes', { count: changes })}</p>
      )}
      {conflicts.length + areaConflicts.length > 0 && (
        <div className="mt-3" data-testid="offline-conflicts">
          <p className="text-xs text-muted-foreground">{tConflicts('description')}</p>
          <ul className="mt-2 divide-y divide-border rounded-md border border-border" aria-label={tConflicts('title')}>
            {conflicts.map((conflict) => (
              <li key={`${conflict.account}:${conflict.id}`} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between" data-testid="offline-conflict-row" data-reason={conflict.summary.reason}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">{conflict.summary.subject || t('no_subject')}</p>
                  <p className="text-xs text-destructive [overflow-wrap:anywhere]">
                    {conflictText(conflict)} · {format.dateTime(conflict.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" aria-label={tConflicts('dismiss_label', { subject: conflict.summary.subject || t('no_subject') })} onClick={() => void dismiss(conflict)}>{tConflicts('dismiss')}</Button>
                </div>
              </li>
            ))}
            {areaConflicts.map((conflict) => (
              <li key={`${conflict.account}:${conflict.area}:${conflict.id}`} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between" data-testid="offline-conflict-row" data-area={conflict.area} data-reason={conflict.reason}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {tStorage(conflict.area === 'calendar' ? 'conflict_calendar' : 'conflict_contacts')}: {conflict.title || t('no_subject')}
                  </p>
                  <p className="text-xs text-destructive [overflow-wrap:anywhere]">
                    {areaConflictText(conflict)} · {format.dateTime(conflict.createdAt, { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button variant="outline" size="sm" aria-label={tConflicts('dismiss_label', { subject: conflict.title || t('no_subject') })} onClick={() => void dismissAreaConflict(conflict)}>{tConflicts('dismiss')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      <ConfirmDialog
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const row = deleting;
          setDeleting(null);
          if (row) void deleteOutboxEntry(row.account, row.id).then(refreshQueueState);
        }}
        title={t('delete_confirm_title')}
        message={t('delete_confirm_message')}
        confirmText={t('delete')}
        variant="destructive"
      />
    </div>
  );
}
