"use client";

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { SearchableSelect, type SearchableOption } from '@/components/ui/searchable-select';
import { AUTO_TIME_ZONE, getBrowserTimeZone, listTimeZones } from '@/lib/timezone';
import { timeZoneChoices, timeZoneCity, type TimeZoneChoice } from '@/lib/time-zone-choices';
import { getEffectiveLocale } from '@/i18n/detect-locale';

/**
 * The time zone setting: a searchable list by city and offset ("Berlin
 * GMT+01:00"), the common zones first. Searching finds a zone by city, id,
 * offset ("+05:30", "UTC-5") or its name in the UI language.
 */
export function TimeZonePicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslations('settings.language_region');
  const tz = useTranslations('uxs_general');

  // The zone list and the browser zone are read after mount: the server has
  // neither, and a mismatch in the options would trip hydration.
  const [browserTimeZone, setBrowserTimeZone] = useState('UTC');
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => {
    setBrowserTimeZone(getBrowserTimeZone());
    setZones(listTimeZones());
  }, []);

  const options = useMemo<SearchableOption[]>(() => {
    // A zone synced from another browser (newer tz database) may be missing
    // from this runtime's list; keep it selectable.
    const extra = value !== AUTO_TIME_ZONE ? [value] : [];
    const { common, all } = timeZoneChoices(zones, { locale: getEffectiveLocale(), extra });
    const toOption = (group: string) => (choice: TimeZoneChoice): SearchableOption => ({
      value: choice.value,
      label: choice.city,
      hint: choice.offset,
      keywords: [choice.value.replace(/_/g, ' '), choice.name, choice.offset.replace('GMT', 'UTC')].filter(Boolean).join(' '),
      group,
    });
    return [
      { value: AUTO_TIME_ZONE, label: t('time_zone.auto', { zone: timeZoneCity(browserTimeZone) }) },
      ...common.map(toOption(tz('time_zone_common'))),
      ...all.map(toOption(tz('time_zone_all'))),
    ];
  }, [zones, value, browserTimeZone, t, tz]);

  const current = options.find((option) => option.value === value);
  return (
    <SearchableSelect
      className="w-64 max-w-full"
      menuClassName="w-72"
      value={value}
      options={options}
      onSelect={onChange}
      ariaLabel={`${t('time_zone.label')}: ${current?.label ?? timeZoneCity(value)}`}
      searchLabel={tz('time_zone_search')}
      noMatchLabel={tz('time_zone_no_match')}
      renderValue={(option) => (
        <span className="flex-1 truncate text-start">
          {option ? option.label : timeZoneCity(value)}
          {option?.hint && <span className="ms-2 text-xs text-muted-foreground">{option.hint}</span>}
        </span>
      )}
    />
  );
}
