'use client';

import { useTranslations } from 'next-intl';
import { Fish } from '@/components/icons';
import { cn } from '@/lib/utils';

/** "You reported this message as phishing. Its links are turned off." above a message with $phishing. */
export function PhishingMarkBanner({ className }: { className?: string }) {
  const t = useTranslations('phishing_report');
  return (
    <div
      role="note"
      data-testid="phishing-mark-banner"
      className={cn('flex items-start gap-2 border-b border-destructive/30 bg-destructive/10 px-6 py-2.5 text-sm text-destructive', className)}
    >
      <Fish className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 font-medium">{t('banner')}</span>
    </div>
  );
}
