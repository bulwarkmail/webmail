'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { wipeWholeDevice } from '@/lib/offline/device-wipe';
import { unsentCount } from '@/lib/offline/offline-mode';

/**
 * "Remove everything from this device", for someone giving a computer away or
 * selling it. It signs out, so the question says exactly what goes.
 */
export function WipeDeviceSection() {
  const t = useTranslations('offlineWipe');
  const [asking, setAsking] = useState(false);
  const [unsent, setUnsent] = useState(0);
  const [wiping, setWiping] = useState(false);

  const ask = async () => {
    const { messages } = await unsentCount('all').catch(() => ({ messages: 0 }));
    setUnsent(messages);
    setAsking(true);
  };

  const confirmed = () => {
    setAsking(false);
    setWiping(true);
    void wipeWholeDevice('user').finally(() => setWiping(false));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border py-3" data-testid="wipe-device-section">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{t('settings_title')}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t('settings_description')}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="text-destructive"
        disabled={wiping}
        onClick={() => { void ask(); }}
        data-testid="wipe-device-button"
      >
        {wiping ? t('settings_wiping') : t('settings_button')}
      </Button>
      <ConfirmDialog
        isOpen={asking}
        onClose={() => setAsking(false)}
        onConfirm={confirmed}
        title={t('confirm_title')}
        message={t('confirm_message')}
        details={(
          <ul className="list-disc space-y-1 ps-5 text-sm text-muted-foreground" data-testid="wipe-device-details">
            <li>{t('confirm_mail')}</li>
            {unsent > 0 && <li className="font-medium text-foreground">{t('confirm_unsent', { count: unsent })}</li>}
            <li>{t('confirm_keys')}</li>
            <li>{t('confirm_plugins')}</li>
            <li>{t('confirm_files')}</li>
            <li>{t('confirm_accounts')}</li>
          </ul>
        )}
        confirmText={t('confirm_button')}
        variant="destructive"
      />
    </div>
  );
}
