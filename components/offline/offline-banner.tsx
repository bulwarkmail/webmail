'use client';

import { useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { CloudOff, X } from '@/components/icons';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { useCloseBesideControls } from '@/hooks/use-close-beside-controls';
import { useConnectionState } from '@/hooks/use-connection-state';
import { IS_LITE } from '@/lib/lite';
import { serverKey, useOfflineStore } from '@/lib/offline/state';
import { useAuthStore } from '@/stores/auth-store';
// The outbox (and offline mode behind it) loads when the dialog opens.
const OutboxList = dynamic(() => import('./outbox-list').then((m) => m.OutboxList), { ssr: false });

/**
 * A strip across the top of the apps while offline mode (#523) answers from
 * this device: the browser is offline (or the mail server can't be
 * reached), and how many messages wait in the outbox. The count opens the
 * outbox in a dialog, which works without a network (a page change might
 * not). Shown only for an account that keeps mail here.
 *
 * It can be hidden until what it says changes (going offline again, another
 * message waiting), for this session of the window.
 *
 * An account that keeps no mail here gets a one-line bar while offline too,
 * so a message that doesn't open isn't a mystery (mail-p2-7).
 */
const HIDDEN_KEY = 'bulwark.offlineBanner.hidden';

function hiddenFor(): string | null {
  try {
    return sessionStorage.getItem(HIDDEN_KEY);
  } catch {
    return null;
  }
}

export function OfflineBanner() {
  const t = useTranslations('offline');
  const account = useAuthStore((s) => s.activeAccountId);
  const server = useAuthStore((s) => s.serverUrl);
  const active = useOfflineStore((s) => !!account && s.enabled.includes(account));
  const browserOffline = useOfflineStore((s) => s.browserOffline || s.startedOffline);
  const serverDown = useOfflineStore((s) => !!server && s.downServers.includes(serverKey(server)));
  const waiting = useOfflineStore((s) => s.outbox.length);
  const conflicts = useOfflineStore((s) => s.conflicts.length + s.areaConflicts.length);
  const refusedDrafts = useOfflineStore((s) => s.localDrafts.filter((draft) => draft.status === 'refused').length);
  const waitingDrafts = useOfflineStore((s) => s.localDrafts.filter((draft) => draft.status !== 'refused').length);
  const tConflicts = useTranslations('offlineConflicts');
  const tDrafts = useTranslations('offlineDrafts');
  const tChrome = useTranslations('windowChrome');
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState<string | null>(hiddenFor);
  const [banner, setBanner] = useState<HTMLDivElement | null>(null);
  const closeFirst = useCloseBesideControls(banner);
  const connection = useConnectionState();
  const tP2 = useTranslations('mail_p2_desk');
  const offline = browserOffline || serverDown;
  if (!active) {
    if (!account || !connection.offline) return null;
    return (
      <div
        role="status"
        data-testid="offline-banner-no-store"
        data-window-top-row=""
        className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-2 text-sm text-foreground sm:px-4"
      >
        <CloudOff className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate" title={tP2('offline_bar')}>{tP2('offline_bar')}</span>
      </div>
    );
  }
  const says = `${browserOffline ? 'offline' : serverDown ? 'down' : 'online'}|${waiting}|${conflicts}|${waitingDrafts}|${refusedDrafts}`;
  if (IS_LITE || !active || (!offline && waiting === 0 && conflicts === 0 && refusedDrafts === 0 && waitingDrafts === 0 && !open)) return null;
  const hide = () => {
    try {
      sessionStorage.setItem(HIDDEN_KEY, says);
    } catch {
      // Hidden for now all the same.
    }
    setHidden(says);
  };
  const close = (
    <IconButton label={tChrome('hide_offline_notice')} onClick={hide} className="-my-1 shrink-0" data-testid="offline-banner-hide">
      <X />
    </IconButton>
  );
  return (
    <>
      {hidden !== says && (
      <div
        ref={setBanner}
        data-testid="offline-banner"
        data-window-top-row=""
        className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-2 text-sm text-foreground sm:px-4"
      >
        {closeFirst && close}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
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
        {conflicts > 0 && (
          <button
            type="button"
            data-testid="offline-banner-conflicts"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="min-h-11 rounded-md px-1 font-medium underline underline-offset-2 hover:bg-foreground/5 sm:min-h-0"
          >
            {tConflicts('banner', { count: conflicts })}
          </button>
        )}
        {waitingDrafts > 0 && (
          <button
            type="button"
            data-testid="offline-banner-drafts-waiting"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="min-h-11 rounded-md px-1 font-medium underline underline-offset-2 hover:bg-foreground/5 sm:min-h-0"
          >
            {tDrafts('banner_waiting', { count: waitingDrafts })}
          </button>
        )}
        {refusedDrafts > 0 && (
          <button
            type="button"
            data-testid="offline-banner-drafts"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            className="min-h-11 rounded-md px-1 font-medium underline underline-offset-2 hover:bg-foreground/5 sm:min-h-0"
          >
            {tDrafts('banner_refused', { count: refusedDrafts })}
          </button>
        )}
        </div>
        {!closeFirst && close}
      </div>
      )}
      <Dialog isOpen={open} onClose={() => setOpen(false)} title={t('outbox.title')} testId="offline-outbox-dialog">
        <OutboxList heading={false} onOpenDraft={() => setOpen(false)} />
      </Dialog>
    </>
  );
}
