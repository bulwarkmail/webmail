import { describe, expect, it } from 'vitest';
import enMessages from '@/locales/en/common.json';
import {
  COMPOSE_FONT_SIZE_IDS,
  DENIED_SETTINGS,
  HOVER_ACTION_IDS,
  MONTH_TIMED_EVENT_STYLE_IDS,
  NOTIFICATION_SOUND_IDS,
  NOT_YET_SETTINGS,
  OFF_LABEL,
  ON_LABEL,
  SETTINGS_SCHEMA,
  isAllowedSettingValue,
  settingValueLabelKey,
  type SettingSchemaEntry,
} from '@/lib/settings-schema';
import { ALL_HOVER_ACTIONS, MONTH_TIMED_EVENT_STYLES, useSettingsStore } from '@/stores/settings-store';
import { useThemeStore } from '@/stores/theme-store';
import { useLocaleStore } from '@/stores/locale-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { NOTIFICATION_SOUNDS } from '@/lib/notification-sound';
import { FONT_SIZES as COMPOSER_FONT_SIZES } from '@/components/email/font-size';
import { UNLOCKABLE_SETTING_KEYS } from '@/lib/accessibility-settings';

// JSON.parse keeps the last of a duplicate key, as next-intl sees it.
const messages = enMessages as unknown as Record<string, unknown>;
const lookup = (key: string): unknown =>
  key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), messages);

/** The settings store's own keys: its state without the actions. */
function storeKeys(): string[] {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
  return Object.keys(state).filter((key) => typeof state[key] !== 'function');
}

function currentValue(entry: SettingSchemaEntry): unknown {
  switch (entry.store) {
    case 'settings': return (useSettingsStore.getState() as unknown as Record<string, unknown>)[entry.key];
    case 'theme': return useThemeStore.getState().theme;
    case 'locale': return useLocaleStore.getState().locale;
    case 'calendar': return useCalendarStore.getState().viewMode;
  }
}

const entries = Object.values(SETTINGS_SCHEMA);
const schema = (key: string) => {
  const entry = SETTINGS_SCHEMA[key];
  if (!entry) throw new Error(`${key} is not in SETTINGS_SCHEMA`);
  return entry;
};

describe('SETTINGS_SCHEMA', () => {
  it('names keys the stores have', () => {
    const keys = new Set(storeKeys());
    for (const entry of entries) {
      expect(entry.key).toBeTruthy();
      if (entry.store === 'settings') expect(keys.has(entry.key), entry.key).toBe(true);
      else expect(['theme', 'locale', 'viewMode']).toContain(entry.key);
    }
    expect(SETTINGS_SCHEMA.theme.store).toBe('theme');
    expect(SETTINGS_SCHEMA.locale.store).toBe('locale');
    expect(SETTINGS_SCHEMA.viewMode.store).toBe('calendar');
  });

  it('uses row and value labels that exist in English', () => {
    expect(typeof lookup(ON_LABEL)).toBe('string');
    expect(typeof lookup(OFF_LABEL)).toBe('string');
    for (const entry of entries) {
      expect(typeof lookup(entry.label), `${entry.key}: ${entry.label}`).toBe('string');
      if (entry.kind.type === 'choice' || entry.kind.type === 'list') {
        for (const option of entry.kind.options) {
          if (option.label === null) continue;
          expect(typeof lookup(option.label), `${entry.key}=${String(option.value)}: ${option.label}`).toBe('string');
        }
      }
    }
    expect(typeof lookup(settingValueLabelKey(schema('timeZone'), 'auto')!)).toBe('string');
  });

  it('allows every default value, except an off safety net that may only be turned on', () => {
    const refused: string[] = [];
    for (const entry of entries) {
      const value = currentValue(entry);
      if (!isAllowedSettingValue(entry, value)) refused.push(`${entry.key}=${JSON.stringify(value)}`);
    }
    // Confirm delete is off by default; a plugin may turn it on, not off.
    // Sender favicons are on by default; a plugin may only switch them off.
    expect(refused.sort()).toEqual(['confirmDelete=false', 'senderFavicons=true']);
  });

  it('marks presets, third-party rows and the inverted switch', () => {
    for (const entry of entries) {
      expect(!!entry.preset, entry.key).toBe(entry.store === 'settings' && UNLOCKABLE_SETTING_KEYS.has(entry.key));
    }
    expect(schema('senderFavicons').thirdParty).toBe(true);
    expect(schema('showAvatarsInJunk').thirdParty).toBe(true);
    expect(schema('disableThreading').inverted).toBe(true);
    expect(schema('unifiedCrossAccount').gate).toBe('unifiedCrossAccountEnabled');
    expect(schema('enableCrossUnreadView').gate).toBe('crossUnreadViewEnabled');
    expect(schema('archiveMode').gate).toBe('archiveActionEnabled');
    expect(schema('hoverActions').gate).toBe('hoverActionsConfigEnabled');
    expect(schema('enableCalendarTasks').gate).toBe('calendarTasksEnabled');
  });

  it('keeps its copies of app lists in step with the app', () => {
    expect(HOVER_ACTION_IDS.map(([id, labelKey]) => ({ id, labelKey }))).toEqual(ALL_HOVER_ACTIONS);
    expect([...MONTH_TIMED_EVENT_STYLE_IDS]).toEqual([...MONTH_TIMED_EVENT_STYLES]);
    expect([...NOTIFICATION_SOUND_IDS]).toEqual(NOTIFICATION_SOUNDS.map((s) => s.id));
    expect([...COMPOSE_FONT_SIZE_IDS]).toEqual([...COMPOSER_FONT_SIZES]);
  });
});

describe('DENIED_SETTINGS and NOT_YET_SETTINGS', () => {
  it('refuses the privacy, mail-sending and dead settings', () => {
    for (const key of [
      'externalContentPolicy', 'trustedSenders', 'signatureDetails', 'pushRelayUrl', 'defaultReplyMode',
      'readAloudVoice', 'sessionTimeout', 'debugMode', 'settingsSyncDisabled',
    ]) {
      expect(SETTINGS_SCHEMA[key], key).toBeUndefined();
      expect(DENIED_SETTINGS, key).toContain(key);
    }
  });

  it('decides every key of the settings store exactly once', () => {
    const allowed = Object.keys(SETTINGS_SCHEMA);
    const all = [...allowed, ...DENIED_SETTINGS, ...NOT_YET_SETTINGS];
    expect(new Set(all).size, 'a key is in two lists').toBe(all.length);
    const undecided = storeKeys().filter((key) => !all.includes(key));
    expect(undecided).toEqual([]);
    // And no list names a key the app doesn't have.
    const known = new Set([...storeKeys(), 'theme', 'locale', 'viewMode', 'activeThemeId']);
    expect(all.filter((key) => !known.has(key))).toEqual([]);
  });
});

describe('isAllowedSettingValue', () => {
  const refuse = (key: string, value: unknown) =>
    expect(isAllowedSettingValue(schema(key), value), `${key}=${JSON.stringify(value)}`).toBe(false);
  const allow = (key: string, value: unknown) =>
    expect(isAllowedSettingValue(schema(key), value), `${key}=${JSON.stringify(value)}`).toBe(true);

  it('refuses the values the plan rules out', () => {
    refuse('deleteAction', 'permanent');
    refuse('readReceiptResponse', 'always');
    refuse('confirmDelete', false);
    refuse('confirmBulkDelete', false);
    refuse('permanentlyDeleteJunk', true);
    refuse('postExportAction', 'trash');
    refuse('timeZone', 'Mars/Base');
    refuse('composeFontFamily', 'Comic Sans MS; background: url(https://evil.example/x)');
    refuse('composeFontSize', '13px');
    // They make the server fetch the sender's domain.
    refuse('senderFavicons', true);
    refuse('showAvatarsInJunk', true);
  });

  it('allows the values the pages offer', () => {
    allow('timeFormat', '12h');
    allow('timeZone', 'Europe/Berlin');
    allow('timeZone', 'auto');
    allow('deleteAction', 'trash-and-read');
    allow('confirmDelete', true);
    allow('confirmBulkDelete', true);
    allow('permanentlyDeleteJunk', false);
    allow('senderFavicons', false);
    allow('showAvatarsInJunk', false);
    allow('postExportAction', 'archive');
    allow('composeFontFamily', 'serif');
    allow('composeFontSize', '18px');
    allow('readReceiptResponse', 'never');
  });

  it('checks types and ranges', () => {
    refuse('timeFormat', '13h');
    refuse('showPreview', 'true');
    refuse('emailsPerPage', '50');
    allow('emailsPerPage', 100);
    refuse('emailsPerPage', 1000);
    refuse('markAsReadDelay', 1000);
    allow('markAsReadDelay', -1);
    allow('calendarDayStartHour', 0);
    refuse('calendarDayStartHour', 24);
    refuse('calendarDayStartHour', 7.5);
    allow('calendarDayEndHour', 24);
    refuse('calendarDayEndHour', 0);
    refuse('timeZone', '+01:00');
    refuse('timeZone', 'europe/berlin');
    refuse('timeZone', 42);
    allow('locale', 'de');
    allow('locale', 'zh-TW');
    allow('locale', '');
    refuse('locale', 'xx');
    allow('theme', 'dark');
    refuse('theme', 'neon');
    allow('viewMode', 'agenda');
    refuse('viewMode', 'tasks');
  });

  it('checks lists', () => {
    allow('calendarWorkingDays', [1, 2, 3]);
    refuse('calendarWorkingDays', []);
    refuse('calendarWorkingDays', [1, 1]);
    refuse('calendarWorkingDays', [7]);
    allow('hoverActions', ['star', 'spam']);
    allow('hoverActions', []);
    refuse('hoverActions', ['star', 'star']);
    refuse('hoverActions', ['forward']);
    allow('attachmentReminderKeywords', ['attached', 'anbei']);
    refuse('attachmentReminderKeywords', ['Attached']);
    refuse('attachmentReminderKeywords', [' attached']);
    refuse('attachmentReminderKeywords', ['a\nb']);
    refuse('attachmentReminderKeywords', ['x'.repeat(41)]);
    refuse('attachmentReminderKeywords', Array.from({ length: 51 }, (_, i) => `w${i}`));
    refuse('attachmentReminderKeywords', 'attached');
  });
});

describe('settingValueLabelKey', () => {
  it('gives the page labels, turning the inverted switch round', () => {
    expect(settingValueLabelKey(schema('showPreview'), true)).toBe(ON_LABEL);
    expect(settingValueLabelKey(schema('showPreview'), false)).toBe(OFF_LABEL);
    // disableThreading true = "Group conversations" off.
    expect(settingValueLabelKey(schema('disableThreading'), true)).toBe(OFF_LABEL);
    expect(settingValueLabelKey(schema('disableThreading'), false)).toBe(ON_LABEL);
    expect(settingValueLabelKey(schema('timeFormat'), '12h')).toBe('settings.language_region.time_format.12h');
    expect(settingValueLabelKey(schema('markAsReadDelay'), -1)).toBe('settings.email_behavior.mark_read.never');
    expect(settingValueLabelKey(schema('firstDayOfWeek'), 0)).toBe('calendar.days.sunday');
  });

  it('gives null for formatted values', () => {
    expect(settingValueLabelKey(schema('calendarDayStartHour'), 8)).toBeNull();
    expect(settingValueLabelKey(schema('readAloudRate'), 1.25)).toBeNull();
    expect(settingValueLabelKey(schema('toastDuration'), 10)).toBeNull();
    expect(settingValueLabelKey(schema('toastDuration'), 0)).toBe('settings.accessibility.toast_duration.until_closed');
    expect(settingValueLabelKey(schema('timeZone'), 'Europe/Berlin')).toBeNull();
  });
});
