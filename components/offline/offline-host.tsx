'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from '@/i18n/navigation';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { addSignOutGate } from '@/lib/sign-out-cleanup';
import { reloadToNewBuild } from '@/lib/app-update';
import { buildSettingsPath } from '@/lib/deep-links';
import { confirmLoss, setOfflineNotifier, startOfflineMode, unsentCount, type OfflineNotice } from '@/lib/offline/offline-mode';
import { toast } from '@/stores/toast-store';

/**
 * Runs offline mode (#523) in this tab: the JMAP client's offline hooks,
 * the outbox, the wipes. Its notices become toasts, and a sign-out the
 * user asked for while messages wait in the outbox asks first. Not mounted
 * in Lite (no offline mode there).
 */
export function OfflineHost() {
  const t = useTranslations('offline');
  const tRef = useRef(t);
  tRef.current = t;
  const tConflicts = useTranslations('offlineConflicts');
  const tConflictsRef = useRef(tConflicts);
  tConflictsRef.current = tConflicts;
  const tStorage = useTranslations('offlineStorage');
  const tStorageRef = useRef(tStorage);
  tStorageRef.current = tStorage;
  const router = useRouter();
  const routerRef = useRef(router);
  routerRef.current = router;
  const { dialogProps, confirm } = useConfirmDialog();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  useEffect(() => {
    const show = (notice: OfflineNotice) => {
      const tr = tRef.current;
      const openStorage = { label: tStorageRef.current('open_settings'), onClick: () => routerRef.current.push(buildSettingsPath('backup', 'offline')) };
      switch (notice.kind) {
        case 'queued':
          toast.info(tr('toast.queued'));
          break;
        case 'sent':
          toast.success(tr('toast.sent', { subject: notice.subject || tr('outbox.no_subject') }));
          break;
        case 'send-failed':
          toast.error(tr('toast.send_failed', { subject: notice.subject || tr('outbox.no_subject') }), {
            message: notice.error.code ? tr(`errors.${notice.error.code}`) : notice.error.text,
          });
          break;
        case 'held':
          toast.warning(tr('toast.held', { subject: notice.subject || tr('outbox.no_subject') }));
          break;
        case 'lost':
          toast.warning(tr('toast.lost', { subjects: notice.subjects.map((s) => s || tr('outbox.no_subject')).join(', ') }), { duration: 0 });
          break;
        case 'conflict':
          toast.warning(tConflictsRef.current('toast', { count: notice.count }));
          break;
        case 'storage-failed':
          toast.warning(tStorageRef.current('storage_full_title'), { message: tStorageRef.current('storage_full_text'), duration: 0, action: openStorage });
          break;
        case 'default-on':
          toast.info(tStorageRef.current('default_on'), { duration: 0, action: openStorage });
          break;
        case 'legacy-stranded':
          toast.warning(tConflictsRef.current('legacy_stranded'), { duration: 0 });
          break;
        case 'store-reset':
          toast.warning(tConflictsRef.current('store_reset'), {
            message: notice.lost > 0 ? tStorageRef.current('evicted_lost', { count: notice.lost }) : undefined,
            duration: 0,
            action: openStorage,
          });
          break;
        case 'store-unavailable':
          toast.warning(tConflictsRef.current('store_unavailable'), { duration: 0 });
          break;
        case 'refused-delete':
          toast.warning(tr('toast.refused_delete'));
          break;
        case 'refused-other':
          toast.warning(tr('toast.refused_other'));
          break;
        case 'forbidden':
          toast.warning(tr('toast.forbidden'));
          break;
        case 'back-online-reload':
          toast.info(tr('toast.back_online'), {
            duration: 0,
            action: { label: tr('toast.reload'), onClick: () => { void reloadToNewBuild(); } },
          });
          break;
      }
    };
    setOfflineNotifier(show);
    const stop = startOfflineMode();
    // Messages that would be lost: ask before a sign-out the user started.
    const removeGate = addSignOutGate(async (accountId) => {
      const { messages, changes } = await unsentCount(accountId);
      if (messages === 0 && changes === 0) return true;
      const tr = tRef.current;
      const trConflicts = tConflictsRef.current;
      const ok = await confirmRef.current({
        title: messages > 0 ? tr('signout.title') : trConflicts('signout_changes_title'),
        message: [
          ...(messages > 0 ? [tr('signout.message', { count: messages })] : []),
          ...(changes > 0 ? [trConflicts('signout_changes', { count: changes })] : []),
        ].join(' '),
        confirmText: tr('signout.confirm'),
        variant: 'destructive',
      });
      // The user agreed: no word about these messages afterwards.
      if (ok) confirmLoss(accountId);
      return ok;
    });
    return () => {
      removeGate();
      stop();
      setOfflineNotifier(null);
    };
  }, []);

  return <ConfirmDialog {...dialogProps} />;
}
