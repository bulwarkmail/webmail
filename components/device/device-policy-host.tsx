'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { useDevicePolicy, useStrictestDevices } from '@/hooks/use-device-policy';
import { DOWNLOAD_BLOCKED_EVENT, type DownloadKind } from '@/lib/download-guard';
// Installs the download guard (lib/download-guard.ts) for every page.
import '@/lib/device-policy';
import { useMailTransferStore } from '@/stores/mail-transfer-store';
import { toast } from '@/stores/toast-store';

/** Set on <html> while printing is off; app/print.css then prints only the note. */
export const NO_PRINT_ATTRIBUTE = 'data-no-print';

/**
 * The page-wide parts of the device policies (Organisation > Devices):
 * - says why nothing happened when a download or export was refused;
 * - Ctrl+P and the browser's Print menu print a page that only says
 *   printing is turned off (they can't be stopped, only blanked);
 * - an export that runs or waits for its download is stopped and its file
 *   deleted when "No export" is switched on while it runs.
 */
export function DevicePolicyHost() {
  const t = useTranslations('device_policy');
  const strictest = useStrictestDevices();
  const activeNoExport = useDevicePolicy().noExport;

  useEffect(() => {
    const onBlocked = (event: Event) => {
      const kind = (event as CustomEvent<{ kind?: DownloadKind }>).detail?.kind;
      toast.info(kind === 'export' ? t('export_blocked') : t('download_blocked'));
    };
    window.addEventListener(DOWNLOAD_BLOCKED_EVENT, onBlocked);
    return () => window.removeEventListener(DOWNLOAD_BLOCKED_EVENT, onBlocked);
  }, [t]);

  useEffect(() => {
    const root = document.documentElement;
    if (strictest.noPrint) root.setAttribute(NO_PRINT_ATTRIBUTE, '');
    else root.removeAttribute(NO_PRINT_ATTRIBUTE);
    return () => root.removeAttribute(NO_PRINT_ATTRIBUTE);
  }, [strictest.noPrint]);

  useEffect(() => {
    if (!activeNoExport) return;
    const store = useMailTransferStore.getState();
    if (store.job?.kind !== 'export') return;
    const job = store.job;
    store.cancelJob('policy');
    // The private file goes at once, once the job has stopped: nothing may download it any more.
    const discard = () => {
      if (useMailTransferStore.getState().job?.controller === job.controller) useMailTransferStore.getState().close({ now: true });
    };
    if (job.finished) void job.finished.then(discard, discard);
    else discard();
  }, [activeNoExport]);

  if (!strictest.noPrint || typeof document === 'undefined') return null;
  return createPortal(
    <div data-print-blocked="" aria-hidden="true">
      <p>{t('print_blocked')}</p>
    </div>,
    document.body,
  );
}
