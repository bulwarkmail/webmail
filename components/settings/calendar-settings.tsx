"use client";

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useCalendarStore, CalendarViewMode } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/stores/toast-store';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';

export function CalendarSettings() {
  const t = useTranslations('calendar.settings');
  const tViews = useTranslations('calendar.views');

  const { viewMode, setViewMode, participantIdentities, fetchParticipantIdentities, setDefaultParticipantIdentity } = useCalendarStore();
  const client = useAuthStore((s) => s.client);

  // ParticipantIdentity list (draft-ietf-jmap-calendars §6): which of the
  // user's addresses organises new invitations. Loaded here because the
  // settings page can open before the calendar app ever did.
  useEffect(() => {
    if (client && participantIdentities.length === 0) {
      void fetchParticipantIdentities(client);
    }
  }, [client, participantIdentities.length, fetchParticipantIdentities]);
  const defaultIdentityId = participantIdentities.find((i) => i.isDefault)?.id ?? participantIdentities[0]?.id ?? '';
  const {
    showTimeInMonthView,
    showWeekNumbers,
    calendarFreeScroll,
    enableCalendarTasks,
    showTasksOnCalendar,
    showBirthdayCalendar,
    calendarHoverPreview,
    updateSetting,
  } = useSettingsStore();
  const { isFeatureEnabled } = usePolicyStore();

  return (
    <SettingsSection title={t('title')}>
      <SettingItem label={t('default_view')}>
        <Select
          value={viewMode}
          onChange={(value) => setViewMode(value as CalendarViewMode)}
          options={[
            { value: 'month', label: tViews('month') },
            { value: 'week', label: tViews('week') },
            { value: 'day', label: tViews('day') },
            { value: 'agenda', label: tViews('agenda') },
          ]}
        />
      </SettingItem>

      {client && participantIdentities.length > 1 && (
        <SettingItem
          label={t('organizer_identity')}
          description={t('organizer_identity_desc')}
        >
          <Select
            value={defaultIdentityId}
            onChange={(value) => {
              setDefaultParticipantIdentity(client, value).catch((err) => {
                toast.error(err instanceof Error ? err.message : t('organizer_identity_failed'));
              });
            }}
            options={participantIdentities.map((i) => {
              const address = i.calendarAddress.replace(/^mailto:/i, '');
              return { value: i.id, label: i.name && i.name !== address ? `${i.name} <${address}>` : address };
            })}
          />
        </SettingItem>
      )}

      <SettingItem
        label={t('show_time_in_month_view')}
        description={t('show_time_in_month_view_desc')}
      >
        <ToggleSwitch
          checked={showTimeInMonthView}
          onChange={(checked) => updateSetting('showTimeInMonthView', checked)}
        />
      </SettingItem>

      <SettingItem
        label={t('show_week_numbers')}
        description={t('show_week_numbers_desc')}
      >
        <ToggleSwitch
          checked={showWeekNumbers}
          onChange={(checked) => updateSetting('showWeekNumbers', checked)}
        />
      </SettingItem>

      <SettingItem
        label={t('calendar_free_scroll')}
        description={t('calendar_free_scroll_desc')}
      >
        <ToggleSwitch
          checked={calendarFreeScroll}
          onChange={(checked) => updateSetting('calendarFreeScroll', checked)}
        />
      </SettingItem>

      <SettingItem
        label={t('hover_preview')}
        description={t('hover_preview_desc')}
      >
        <Select
          value={calendarHoverPreview}
          onChange={(value) => updateSetting('calendarHoverPreview', value as 'off' | 'instant' | 'delay-500ms' | 'delay-1s' | 'delay-2s')}
          options={[
            { value: 'instant', label: t('hover_preview_instant') },
            { value: 'delay-500ms', label: t('hover_preview_delay_500ms') },
            { value: 'delay-1s', label: t('hover_preview_delay_1s') },
            { value: 'delay-2s', label: t('hover_preview_delay_2s') },
            { value: 'off', label: t('hover_preview_off') },
          ]}
        />
      </SettingItem>

      <SettingItem
        label={t('show_birthday_calendar')}
        description={t('show_birthday_calendar_desc')}
      >
        <ToggleSwitch
          checked={showBirthdayCalendar}
          onChange={(checked) => updateSetting('showBirthdayCalendar', checked)}
        />
      </SettingItem>

      {isFeatureEnabled('calendarTasksEnabled') && (
      <>
      <SettingItem
        label={t('enable_tasks')}
        description={t('enable_tasks_desc')}
      >
        <ToggleSwitch
          checked={enableCalendarTasks}
          onChange={(checked) => updateSetting('enableCalendarTasks', checked)}
        />
      </SettingItem>

      {enableCalendarTasks && (
        <SettingItem
          label={t('show_tasks_on_calendar')}
          description={t('show_tasks_on_calendar_desc')}
        >
          <ToggleSwitch
            checked={showTasksOnCalendar}
            onChange={(checked) => updateSetting('showTasksOnCalendar', checked)}
          />
        </SettingItem>
      )}
      </>
      )}

    </SettingsSection>
  );
}
