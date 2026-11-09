'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { LabelIcon } from '@/components/icons';
import type { Email } from '@/lib/jmap/types';
import { DEFAULT_ORGANISATION_POLICY } from '@/lib/admin/organisation-policy';
import { receivedLabel, textColorOn } from '@/lib/classification/labels';
import { useAccountPolicy } from '@/hooks/use-account-policy';
import { cn } from '@/lib/utils';

/**
 * The classification label a received message carries, when it is one of
 * the labels of the message's own account (SIO-Label marking, else the
 * admin's extra header). Information only: anyone can write the header,
 * so nothing is relaxed because of it. List rows don't show it (they don't
 * fetch the headers).
 */
export function ReceivedLabelChip({ email, className }: { email: Pick<Email, 'headers' | 'sourceClientAccountId'>; className?: string }) {
  const t = useTranslations('classification');
  const policy = useAccountPolicy(email.sourceClientAccountId);
  const labels = policy.organisation?.labels ?? DEFAULT_ORGANISATION_POLICY.labels;
  const label = useMemo(() => receivedLabel(email.headers, labels), [email.headers, labels]);
  if (!label) return null;
  const name = t('chip_label', { name: label.name });
  return (
    <span
      data-testid="received-label-chip"
      title={`${name}. ${t('received_hint')}`}
      aria-label={name}
      role="img"
      className={cn('inline-flex max-w-full shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium leading-4', className)}
      style={{ backgroundColor: label.color, color: textColorOn(label.color) }}
    >
      <LabelIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate" aria-hidden="true">{label.name}</span>
    </span>
  );
}
