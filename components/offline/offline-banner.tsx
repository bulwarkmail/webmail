'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { CloudOff } from '@/components/icons';
import { Dialog } from '@/components/ui/dialog';
import { IS_LITE } from '@/lib/lite';
import { serverKey, useOfflineStore } from '@/lib/offline/state';
import { useAuthStore } from '@/stores/auth-store';
import { OutboxList } from './outbox-list';

/**
 * A strip across the top of the apps while offline mode (#523) answers from
 * this device: the browser is offline (or the mail server can't be
 * reached), and how many messages wait in the outbox. The count opens the
 * outbox in a dialog, which works without a network (a page change might
 * not). Shown only for an account that keeps mail here.
 */
export function OfflineBanner() {
  const t = useTranslations('offline');
  const account = useAuthStore((s) => s.activeAccountId);
  const server = useAuthStore((s) => s.serverUrl);
  const active = useOfflineStore((s) => !!account && s.enabled.includes(account));
  const browserOffline = useOfflineStore((s) => s.browserOffline || s.startedOffline);
  const serverDown = useOfflineStore((s) => !!server && s.downServers.includes(serverKey(server)));
  const waiting = useOfflineStore((s) => s.outbox.length);
  const [open, setOpen] = useState(false);
  const offline = browserOffline || serverDown;
  if (IS_LITE || !active || (!offline && waiting === 0 && !open)) return null;
  return (
    <>
      <div
        data-testid="offline-banner"
        className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted px-3 py-2 text-sm text-foreground sm:px-4"
      >
        {offline && (
          <span className="flex min-w-0 items-start gap-2" role="status">
            <CloudOff className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 [overflow-wrap:anywhere]">{browserOffline ? t('banner.offline') : t('banner.server_down')}</span>
          </span>
        )}
        {waiting > 0 && (
          <button
            type="button"
            data-testid="offline-banner-outbox"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="min-h-11 rounded-md px-1 font-medium underline underline-offset-2 hover:bg-foreground/5 sm:min-h-0"
          >
            {t('banner.outbox', { count: waiting })}
          </button>
        )}
      </div>
      <Dialog isOpen={open} onClose={() => setOpen(false)} title={t('outbox.title')} testId="offline-outbox-dialog">
        <OutboxList heading={false} />
      </Dialog>
    </>
  );
}
