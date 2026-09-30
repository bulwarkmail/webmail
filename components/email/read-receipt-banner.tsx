'use client';

import { useState } from 'react';
import { MailCheck, Loader2, CheckCircle, X } from '@/components/icons';
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

  // Matches the host's "External Content" banner row: a round tinted icon chip,
  // an uppercase eyebrow, a foreground message, and neutral bordered actions.
  if (state === 'sent') {
    return (
      <div className="flex items-center gap-3 py-1">
        <div className="w-10 h-10 rounded-full bg-success/15 text-success flex items-center justify-center flex-shrink-0 shadow-sm">
          <CheckCircle className="w-5 h-5" />
        </div>
        <span className="text-sm text-muted-foreground">{t('sent')}</span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 py-1">
      <div className="w-10 h-10 rounded-full bg-info/15 text-info flex items-center justify-center flex-shrink-0 shadow-sm">
        <MailCheck className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0 space-y-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Read receipt
          </div>
          <div className="text-sm font-medium text-foreground break-words">
            {t('prompt')}
          </div>
          <div className="text-xs text-muted-foreground break-all">
            Requested by <span className="text-foreground/80">{requestedBy}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
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
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {state === 'sending' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MailCheck className="w-3.5 h-3.5" />}
            {t('send')}
          </button>
          <button
            onClick={onIgnore}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground px-3 py-1.5 rounded-md border border-border hover:bg-muted transition-colors min-h-[36px]"
          >
            <X className="w-3.5 h-3.5" />
            {t('ignore')}
          </button>
        </div>
      </div>
    </div>
  );
}
