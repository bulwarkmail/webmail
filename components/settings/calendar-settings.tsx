"use client";

import { useTranslations } from 'next-intl';
import { useCalendarStore, CalendarViewMode } from '@/stores/calendar-store';
import { useSettingsStore } from '@/stores/settings-store';
import { usePolicyStore } from '@/stores/policy-store';
import { SettingsSection, SettingItem, Select, RadioGroup, ToggleSwitch } from './settings-section';

export function CalendarSettings() {
  const t = useTranslations('calendar.settings');
  const tViews = useTranslations('calendar.views');
  const tDays = useTranslations('calendar.days');

  const { viewMode, setViewMode } = useCalendarStore();
  const {
    timeFormat,
    firstDayOfWeek,
    showTimeInMonthView,
    showWeekNumbers,
    enableCalendarTasks,
    showTasksOnCalendar,
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

      <SettingItem label={t('week_starts_on')}>
        <Select
          value={firstDayOfWeek.toString()}
          onChange={(value) => updateSetting('firstDayOfWeek', parseInt(value) as 0 | 1)}
          options={[
            { value: '1', label: tDays('monday') },
            { value: '0', label: tDays('sunday') },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('time_format')}>
        <RadioGroup
          value={timeFormat}
          onChange={(value) => updateSetting('timeFormat', value as '12h' | '24h')}
          options={[
            { value: '12h', label: t('time_format_12h') },
            { value: '24h', label: t('time_format_24h') },
          ]}
        />
      </SettingItem>

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
