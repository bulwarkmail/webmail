'use client';

import { useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useConfirmDialog } from '@/hooks/use-confirm-dialog';
import { addSignOutGate } from '@/lib/sign-out-cleanup';
import { reloadToNewBuild } from '@/lib/app-update';
import { confirmLoss, setOfflineNotifier, startOfflineMode, type OfflineNotice } from '@/lib/offline/offline-mode';
import { useOfflineStore } from '@/lib/offline/state';
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
  const { dialogProps, confirm } = useConfirmDialog();
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  useEffect(() => {
    const show = (notice: OfflineNotice) => {
      const tr = tRef.current;
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
      const unsent = useOfflineStore.getState().outbox.filter((row) => accountId === 'all' || row.account === accountId).length;
      if (unsent === 0) return true;
      const tr = tRef.current;
      const ok = await confirmRef.current({
        title: tr('signout.title'),
        message: tr('signout.message', { count: unsent }),
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
      setOfflineNotifier(() => {});
    };
  }, []);

  return <ConfirmDialog {...dialogProps} />;
}
