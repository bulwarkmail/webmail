'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useArchiveActionEnabled } from '@/lib/archive-gate';
import { scheduleFlushAll } from '@/lib/offline/offline-mode';
import { isNotificationActionRequest, runNotificationAction } from '@/lib/pwa-notify/page-actions';
import { writeNotificationActionPrefs } from '@/lib/pwa-notify/worker-state';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * This tab's end of what the service worker can't do alone: it keeps the
 * worker's copy of the labels and archive settings current, runs a
 * notification's buttons and flushes the outbox on the worker's word. Not
 * mounted in Lite (no service worker there).
 */
export function NotificationActionsHost() {
  const t = useTranslations('pwaNotify');
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const archiveMode = useSettingsStore((s) => s.archiveMode);
  const archiveEnabled = useArchiveActionEnabled();
  const archive = t('action_archive');
  const markRead = t('action_mark_read');
  const reply = t('action_reply');
  const replyPlaceholder = t('reply_placeholder');

  // Signing out deletes the worker's store, so signing in writes it again.
  useEffect(() => {
    if (!isAuthenticated) return;
    void writeNotificationActionPrefs({
      archiveEnabled,
      archiveMode,
      labels: { archive, markRead, reply, replyPlaceholder },
    });
  }, [isAuthenticated, archiveEnabled, archiveMode, archive, markRead, reply, replyPlaceholder]);

  useEffect(() => {
    const worker = navigator.serviceWorker;
    if (!worker) return;
    const onMessage = (event: MessageEvent) => {
      const message = event.data as { kind?: string } | null;
      if (message?.kind === 'outbox-flush') {
        scheduleFlushAll(0);
        return;
      }
      if (message?.kind !== 'notification-action' || !isNotificationActionRequest(message)) return;
      const port = event.ports[0];
      void runNotificationAction(message, (status) => port?.postMessage({ status }));
    };
    worker.addEventListener('message', onMessage);
    return () => worker.removeEventListener('message', onMessage);
  }, []);

  return null;
}
