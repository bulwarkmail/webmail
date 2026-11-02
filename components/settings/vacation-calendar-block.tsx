'use client';

import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from '@/components/icons';
import { SettingItem } from './settings-section';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useVacationStore } from '@/stores/vacation-store';
import { useRestriction } from '@/hooks/use-restriction';
import { blockCalendar, ownFilterScriptStops, resolveBlockSetting, vacationBlockChanged } from '@/lib/vacation-calendar';
import { usePolicyStore } from '@/stores/policy-store';

/**
 * "Block my calendar" under the out-of-office dates (lib/vacation-calendar.ts):
 * on by default, lockable by the organisation (vacationBlockCalendar). Shown
 * once both dates are set. For a managed account the event goes into that
 * account's calendar, which the user needs write access to.
 */
export function VacationCalendarBlock({ hasDates, accountId }: { hasDates: boolean; accountId?: string }) {
  const t = useTranslations('vacation_calendar');
  const client = useAuthStore((s) => s.client);
  const setting = useSettingsStore((s) => s.vacationBlockCalendar);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const restriction = useRestriction('vacationBlockCalendar');
  const policyDefault = usePolicyStore((s) => s.policy.defaults?.vacationBlockCalendar);
  // The same resolution as the sync (lib/vacation-calendar.ts).
  const { value: checked, locked, hidden } = resolveBlockSetting(restriction, policyDefault, setting);
  const [access, setAccess] = useState<{ key: string; ok: boolean } | null>(null);
  const id = useId();
  const key = accountId ?? '';
  // Stand-in clients (tests, the demo) may not say.
  const supported = typeof client?.supportsCalendars === 'function' && client.supportsCalendars();

  useEffect(() => {
    if (!client || !supported || !hasDates) return;
    let cancelled = false;
    void client.getAllCalendars()
      .then((calendars) => !!blockCalendar(calendars, accountId ?? client.getAccountId(), client.getAccountId()))
      // Not knowing is no reason to hide the option.
      .catch(() => true)
      .then((ok) => { if (!cancelled) setAccess({ key, ok }); });
    return () => { cancelled = true; };
  }, [client, supported, hasDates, accountId, key]);

  if (!client || !supported || !hasDates || hidden) return null;
  if (access?.key === key && !access.ok) {
    return (
      <p className="pb-2 text-xs text-muted-foreground" data-testid="vacation-block-no-access">
        {t(accountId ? 'no_access_managed' : 'no_calendar')}
      </p>
    );
  }

  const onChange = (next: boolean) => {
    updateSetting('vacationBlockCalendar', next);
    const { isEnabled, fromDate, toDate, subject } = useVacationStore.getState();
    vacationBlockChanged(client, accountId, { isEnabled, fromDate, toDate, subject });
  };

  return (
    <SettingItem label={t('label')} description={t('description')} locked={locked}>
      <input
        id={id}
        type="checkbox"
        aria-label={t('label')}
        className="h-5 w-5 rounded border-input accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="vacation-block-calendar"
      />
    </SettingItem>
  );
}

/**
 * The one line under the reply switch when turning it on would switch off a
 * filter script of the user's own (Stalwart runs one script at a time).
 */
export function VacationFilterWarning({ accountId }: { accountId?: string }) {
  const t = useTranslations('vacation_calendar');
  const client = useAuthStore((s) => s.client);
  const [stops, setStops] = useState<{ key: string; value: boolean } | null>(null);
  const key = accountId ?? '';
  const sieve = !!client && typeof client.getSieveScripts === 'function'
    && (accountId ? client.accountSupports(accountId, 'urn:ietf:params:jmap:sieve') : client.supportsSieve());

  useEffect(() => {
    if (!client || !sieve) return;
    let cancelled = false;
    void ownFilterScriptStops(client, accountId).catch(() => false).then((value) => {
      if (!cancelled) setStops({ key, value });
    });
    return () => { cancelled = true; };
  }, [client, sieve, accountId, key]);

  if (!stops || stops.key !== key || !stops.value) return null;
  return (
    <p className="flex items-start gap-1.5 -mt-1 pb-2 text-xs text-amber-600 dark:text-amber-400" data-testid="vacation-filter-warning">
      <AlertTriangle className="mt-px h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
      <span>{t('filter_warning')}</span>
    </p>
  );
}
