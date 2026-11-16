'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { SHARE_NEEDS_TAP_EVENT, shareAfterTap, type ShareNeedsTapDetail } from '@/lib/download-guard';
import { toast } from '@/stores/toast-store';

/**
 * On an iPhone or iPad, saveBlobAs() (lib/download-guard.ts) hands a file iOS
 * can't preview, such as a "Download all" zip, to the share sheet. iOS opens
 * the sheet only straight after a tap, so when fetching or zipping took
 * longer, this offers the file with a Save button: shareAfterTap() asks the
 * device policy again, then opens the sheet.
 */
export function ShareSheetHost() {
  const t = useTranslations('common');

  useEffect(() => {
    const onNeedsTap = (event: Event) => {
      const detail = (event as CustomEvent<ShareNeedsTapDetail>).detail;
      if (!detail?.file) return;
      toast.info(t('ready_to_save'), {
        message: detail.file.name,
        duration: 30_000,
        action: { label: t('save'), onClick: () => shareAfterTap(detail) },
      });
    };
    window.addEventListener(SHARE_NEEDS_TAP_EVENT, onNeedsTap);
    return () => window.removeEventListener(SHARE_NEEDS_TAP_EVENT, onNeedsTap);
  }, [t]);

  return null;
}
