'use client';

import { useTranslations } from 'next-intl';
import { ArrowDown } from '@/components/icons';
import type { Email } from '@/lib/jmap/types';
import { emailPriority } from '@/lib/message-priority';
import { cn } from '@/lib/utils';

/**
 * "High importance" / "Low importance" on a received message whose
 * X-Priority or Importance header says so (#1809). Normal shows nothing.
 */
export function ImportanceChip({ email, className }: { email: Pick<Email, 'headers' | 'priority'>; className?: string }) {
  const t = useTranslations('email_list');
  const priority = emailPriority(email);
  if (priority === 'normal') return null;
  const high = priority === 'high';
  return (
    <span
      data-testid="importance-chip"
      data-priority={priority}
      className={cn(
        'inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-xs font-medium leading-none',
        high ? 'border-destructive/30 bg-destructive/10 text-destructive' : 'border-border bg-muted text-muted-foreground',
        className,
      )}
    >
      {high
        ? <span aria-hidden="true" className="font-bold">!</span>
        : <ArrowDown className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
      {t(high ? 'high_importance' : 'low_importance')}
    </span>
  );
}
