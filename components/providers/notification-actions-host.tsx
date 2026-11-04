'use client';

import { useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useArchiveActionEnabled } from '@/lib/archive-gate';
import { scheduleFlushAll } from '@/lib/offline/offline-mode';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { writeLoginQuiet } from '@/lib/push-preferences';
import { isNotificationActionRequest, runNotificationAction } from '@/lib/pwa-notify/page-actions';
import { pluginsMayVeto } from '@/lib/pwa-notify/plugin-veto';
import { writeNotificationActionPrefs } from '@/lib/pwa-notify/worker-state';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePluginStore } from '@/stores/plugin-store';
import { useSettingsStore } from '@/stores/settings-store';

/**
 * This tab's end of what the service worker can't do alone: it keeps the
 * worker's copy of the labels and archive settings current, says which logins
 * it holds, runs a notification's buttons and flushes the outbox on the
 * worker's word. Not mounted in Lite (no service worker there).
 */
export function NotificationActionsHost() {
  const t = useTranslations('pwaNotify');
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const archiveMode = useSettingsStore((s) => s.archiveMode);
  const archiveEnabled = useArchiveActionEnabled();
  const mayVeto = usePluginStore((s) => pluginsMayVeto(s.plugins));
  const accounts = useAccountStore((s) => s.accounts);
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
      pluginsMayVeto: mayVeto,
      labels: { archive, markRead, reply, replyPlaceholder },
    });
  }, [isAuthenticated, archiveEnabled, archiveMode, mayVeto, archive, markRead, reply, replyPlaceholder]);

  // Email notifications off or do not disturb on, for the login on screen: the
  // worker shows nothing for that login's mail. The label a push carries is this
  // name (lib/web-push.ts), and each login has its own settings.
  const username = useAuthStore((s) => s.username);
  const quiet = useSettingsStore((s) => !s.emailNotificationsEnabled || s.doNotDisturb);
  useEffect(() => {
    if (!isAuthenticated || !username) return;
    void writeLoginQuiet(username, quiet);
  }, [isAuthenticated, username, quiet]);

  // Which logins this tab holds: if it stays silent on a click for one of them,
  // the worker opens the message rather than go round its plugins.
  const loginKey = useMemo(() => accounts.map((a) => `${a.serverUrl}\n${a.username}`).join('\n\n'), [accounts]);
  useEffect(() => {
    const worker = navigator.serviceWorker;
    if (!worker) return;
    let stale = false;
    void (async () => {
      try {
        const held = await Promise.all(useAccountStore.getState().accounts.map((a) => loginFingerprint(a.serverUrl, a.username)));
        // Without a worker `ready` never settles, and nothing needs telling.
        const target = worker.controller ?? (await worker.ready).active;
        if (!stale) target?.postMessage({ type: 'client-logins', logins: held });
      } catch {
        // The worker counts this tab as not holding them.
      }
    })();
    return () => { stale = true; };
  }, [loginKey, isAuthenticated]);

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
