import { describe, expect, it } from 'vitest';
import { migrateSettings, useSettingsStore } from '../settings-store';
import { SETTINGS_SCHEMA } from '@/lib/settings-schema';
import { ACCESSIBILITY_DEFAULTS } from '@/lib/accessibility-settings';

// Plain wording is the only wording now (settings-15): the switch, its
// default and its stored value are gone, and an old stored value is ignored.

describe('the old plain-language setting', () => {
  it('is not a setting any more', () => {
    expect('plainLanguage' in ACCESSIBILITY_DEFAULTS).toBe(false);
    expect('plainLanguage' in useSettingsStore.getState()).toBe(false);
    expect('plainLanguage' in SETTINGS_SCHEMA).toBe(false);
  });

  it('is dropped from stored settings', () => {
    const migrated = migrateSettings({ plainLanguage: true, sendDelaySeconds: 0 }, 11) as unknown as Record<string, unknown>;
    expect('plainLanguage' in migrated).toBe(false);
  });

  it('is not taken over from an imported settings file', () => {
    useSettingsStore.getState().importSettings(JSON.stringify({ plainLanguage: true }));
    expect('plainLanguage' in useSettingsStore.getState()).toBe(false);
  });
});
