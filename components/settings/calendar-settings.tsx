"use client";

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useCalendarStore, CalendarViewMode } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { useAuthStore } from '@/stores/auth-store';
import { toast } from '@/stores/toast-store';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { cn } from '@/lib/utils';
import { formatDisplayHour } from '@/lib/calendar-display-range';

// Indexed by Date.getDay(), which is how calendarWorkingDays stores days.
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const DAY_SHORT_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function CalendarSettings() {
  const t = useTranslations('calendar.settings');
  const tViews = useTranslations('calendar.views');
  const tDays = useTranslations('calendar.days');

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
    calendarLimitHours,
    calendarDayStartHour,
    calendarDayEndHour,
    calendarHideNonWorkingDays,
    calendarWorkingDays,
    timeFormat,
    firstDayOfWeek,
    updateSetting,
  } = useSettingsStore();
  const { isFeatureEnabled } = usePolicyStore();

  // Visible hours (#1164). The end list only offers hours after the start,
  // and moving the start past the end pushes the end along.
  const hourOptions = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => {
      const hour = from + i;
      return { value: String(hour), label: formatDisplayHour(hour, timeFormat) };
    });
  const setStartHour = (hour: number) => {
    updateSetting('calendarDayStartHour', hour);
    if (calendarDayEndHour <= hour) updateSetting('calendarDayEndHour', hour + 1);
  };

  // Working days in the order the user's week runs.
  const weekOrder = Array.from({ length: 7 }, (_, i) => (firstDayOfWeek + i) % 7);
  const workingDays = Array.isArray(calendarWorkingDays) ? calendarWorkingDays : [];
  const toggleWorkingDay = (day: number) => {
    const current = new Set(workingDays);
    if (current.has(day)) {
      // The week view needs at least one day to show.
      if (current.size === 1) return;
      current.delete(day);
    } else {
      current.add(day);
    }
    updateSetting('calendarWorkingDays', [...current].sort((a, b) => a - b));
  };

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
        label={t('limit_hours')}
        description={t('limit_hours_desc')}
      >
        <ToggleSwitch
          checked={calendarLimitHours}
          onChange={(checked) => updateSetting('calendarLimitHours', checked)}
        />
      </SettingItem>

      {calendarLimitHours && (
        <SettingItem label={t('visible_hours')}>
          <div className="flex items-center gap-2">
            <Select
              value={String(calendarDayStartHour)}
              onChange={(value) => setStartHour(parseInt(value, 10))}
              options={hourOptions(0, 23)}
              ariaLabel={t('visible_hours_start')}
            />
            <span className="text-muted-foreground">–</span>
            <Select
              value={String(calendarDayEndHour)}
              onChange={(value) => updateSetting('calendarDayEndHour', parseInt(value, 10))}
              options={hourOptions(Math.min(23, calendarDayStartHour) + 1, 24)}
              ariaLabel={t('visible_hours_end')}
            />
          </div>
        </SettingItem>
      )}

      <SettingItem
        label={t('hide_non_working_days')}
        description={t('hide_non_working_days_desc')}
      >
        <ToggleSwitch
          checked={calendarHideNonWorkingDays}
          onChange={(checked) => updateSetting('calendarHideNonWorkingDays', checked)}
        />
      </SettingItem>

      {calendarHideNonWorkingDays && (
        <SettingItem label={t('working_days')}>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('working_days')}>
            {weekOrder.map((day) => {
              const selected = workingDays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  aria-label={tDays(DAY_KEYS[day])}
                  title={tDays(DAY_KEYS[day])}
                  onClick={() => toggleWorkingDay(day)}
                  className={cn(
                    'px-2.5 py-1.5 text-xs rounded-md transition-colors duration-150',
                    selected
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'bg-muted hover:bg-accent text-foreground'
                  )}
                >
                  {tDays(DAY_SHORT_KEYS[day])}
                </button>
              );
            })}
          </div>
        </SettingItem>
      )}

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
