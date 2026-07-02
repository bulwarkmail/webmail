"use client";

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { LanguageSwitcher } from '@/components/ui/language-switcher';
import { useLocaleStore } from '@/stores/locale-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { DateFormat, DateLocale, TimeFormat, FirstDayOfWeek } from '@/stores/settings-store';
import { formatDate } from '@/lib/utils';
import { SettingsSection, SettingItem, Select, RadioGroup } from './settings-section';

export function LanguageSettings() {
  const t = useTranslations('settings.language_region');
  const tDays = useTranslations('calendar.days');

  const { dateFormat, dateLocale, timeFormat, firstDayOfWeek, updateSetting } = useSettingsStore();

  // Subscribe to locale changes so the preview re-renders on language switch
  // (formatDate reads it via getState() and would otherwise stay stale).
  const locale = useLocaleStore((s) => s.locale);

  const preview = useMemo(() => {
    // Build sample timestamps for each bucket so users see what their pick
    // will look like in practice. Use offsets relative to "now" so the
    // bucketing is stable even though the wall-clock keeps moving.
    void locale; void dateFormat; void dateLocale; void timeFormat;
    const now = new Date();
    const today = new Date(now);
    today.setHours(15, 31, 0, 0);
    const thisWeek = new Date(now);
    thisWeek.setDate(now.getDate() - 2);
    thisWeek.setHours(15, 31, 0, 0);
    const older = new Date(now);
    older.setMonth(now.getMonth() - 2);
    older.setHours(15, 31, 0, 0);
    return {
      today: formatDate(today),
      thisWeek: formatDate(thisWeek),
      older: formatDate(older),
    };
  }, [locale, dateFormat, dateLocale, timeFormat]);

  return (
    <SettingsSection title={t('title')} description={t('description')}>
      <SettingItem label={t('language.label')} description={t('language.description')}>
        <LanguageSwitcher />
      </SettingItem>

      <SettingItem label={t('date_format.label')} description={t('date_format.description')}>
        <div className="flex flex-col items-end gap-2">
          <Select
            value={dateFormat}
            onChange={(value) => updateSetting('dateFormat', value as DateFormat)}
            options={[
              { value: 'smart', label: t('date_format.smart') },
              { value: 'relative', label: t('date_format.relative') },
              { value: 'full', label: t('date_format.full') },
            ]}
          />
          <div className="text-xs text-muted-foreground text-right space-y-0.5 font-mono">
            <div>
              <span className="opacity-70">{t('date_format.preview_today')} </span>
              <span className="text-foreground/90">{preview.today}</span>
            </div>
            <div>
              <span className="opacity-70">{t('date_format.preview_this_week')} </span>
              <span className="text-foreground/90">{preview.thisWeek}</span>
            </div>
            <div>
              <span className="opacity-70">{t('date_format.preview_older')} </span>
              <span className="text-foreground/90">{preview.older}</span>
            </div>
          </div>
        </div>
      </SettingItem>

      <SettingItem label={t('date_locale.label')} description={t('date_locale.description')}>
        <Select
          value={dateLocale}
          onChange={(value) => updateSetting('dateLocale', value as DateLocale)}
          options={[
            { value: 'auto', label: t('date_locale.auto') },
            { value: 'iso', label: t('date_locale.iso') },
            { value: 'en-GB', label: t('date_locale.dmy') },
            { value: 'en-US', label: t('date_locale.mdy') },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('time_format.label')} description={t('time_format.description')}>
        <RadioGroup
          value={timeFormat}
          onChange={(value) => updateSetting('timeFormat', value as TimeFormat)}
          options={[
            { value: '12h', label: t('time_format.12h') },
            { value: '24h', label: t('time_format.24h') },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('first_day.label')} description={t('first_day.description')}>
        <Select
          value={firstDayOfWeek.toString()}
          onChange={(value) => updateSetting('firstDayOfWeek', parseInt(value) as FirstDayOfWeek)}
          options={[
            { value: '1', label: tDays('monday') },
            { value: '0', label: tDays('sunday') },
          ]}
        />
      </SettingItem>
    </SettingsSection>
  );
}
