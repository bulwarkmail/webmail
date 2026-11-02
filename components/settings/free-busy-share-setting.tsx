"use client";

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { SettingItem } from './settings-section';
import { FreeBusyShareButton } from '@/components/calendar/free-busy-share-button';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { freeBusyShareGroups } from '@/lib/free-busy-share';

/**
 * Settings > Calendar > Free/busy: share the default calendar's busy times
 * with the admin's free/busy group or one of the user's groups. Hidden when
 * there is no group to share with.
 */
export function FreeBusyShareSetting() {
  const t = useTranslations('free_busy_share');
  const client = useAuthStore((s) => s.client);
  const adminGroup = usePolicyStore((s) => s.policy.organisation?.calendars?.freeBusyGroup ?? '');
  const groups = useMemo(() => freeBusyShareGroups(client, adminGroup), [client, adminGroup]);
  if (!client?.supportsCalendars() || groups.length === 0) return null;
  return (
    <SettingItem label={t('title')} description={t('description')}>
      <FreeBusyShareButton />
    </SettingItem>
  );
}
