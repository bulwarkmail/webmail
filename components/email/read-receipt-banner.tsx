'use client';

import { useState } from 'react';
import { MailCheck, Loader2, CheckCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface ReadReceiptBannerProps {
  /** Address that requested the receipt (Disposition-Notification-To). */
  requestedBy: string;
  /** Sends the MDN. Should resolve when the receipt has been submitted. */
  onSend: () => Promise<void>;
  /** Suppresses the request without sending (sets $MDNSent server-side). */
  onIgnore: () => void;
}

export function ReadReceiptBanner({ requestedBy, onSend, onIgnore }: ReadReceiptBannerProps) {
  const t = useTranslations('email_viewer.read_receipt');
  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');

  if (state === 'sent') {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
        <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
        <span>{t('sent')}</span>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-sm dark:border-amber-700/50 dark:bg-amber-950/30">
      <MailCheck className="w-4 h-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="text-foreground">{t('prompt')}</span>
      <span className="break-all text-muted-foreground">{requestedBy}</span>
      <div className="ms-auto flex items-center gap-2">
        <button
          onClick={async () => {
            setState('sending');
            try {
              await onSend();
              setState('sent');
            } catch {
              setState('idle');
            }
          }}
          disabled={state === 'sending'}
          className="inline-flex items-center gap-1.5 rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === 'sending' && <Loader2 className="w-3 h-3 animate-spin" />}
          {t('send')}
        </button>
        <button
          onClick={onIgnore}
          className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-700"
        >
          {t('ignore')}
        </button>
      </div>
    </div>
  );
}
