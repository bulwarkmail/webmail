import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/browser-navigation', () => ({ apiFetch: vi.fn() }));

import { adminPolicyPatch, useSettingsStore } from '@/stores/settings-store';
import { ACCESSIBILITY_ALLOWED, ACCESSIBILITY_KEYS, UNLOCKABLE_SETTING_KEYS } from '@/lib/accessibility-settings';
import { RESTRICTION_KEYS, restrictionKeysForPage } from '@/lib/admin/restriction-keys';
import {
  ACCESSIBILITY_POLICY_SETTINGS,
  PRESETTABLE_SETTINGS,
  defaultAt,
  effectiveDefault,
  otherDefaultKeys,
  parseFreeSettingValue,
  restrictionAt,
  withDefaultAt,
  withRestrictionAt,
} from '@/lib/admin/policy-settings';
import { DEFAULT_POLICY, type SettingsPolicy } from '@/lib/admin/types';

// The User policy page presets and locks settings with values users'
// browsers accept: the same keys, labels and values as the settings store
// and the user's own Settings > Accessibility page (AL-11, AL-12).

const en = JSON.parse(readFileSync(join(process.cwd(), 'locales/en/common.json'), 'utf-8'));
const lookup = (path: string) => path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], en);
const builtIn = useSettingsStore.getState() as unknown as Record<string, unknown>;

/** What the store applies for this policy, for a user who never chose the setting. */
function applied(key: string, policy: Partial<SettingsPolicy>, current: unknown = Symbol('unset')): unknown {
  const patch = adminPolicyPatch({ explicitSettings: [], [key]: current }, policy);
  return Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : undefined;
}

describe('the accessibility defaults catalog', () => {
  it('lists every accessibility option and text size, once each', () => {
    const keys = ACCESSIBILITY_POLICY_SETTINGS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [...ACCESSIBILITY_KEYS, 'fontSize']) expect(keys).toContain(key);
    expect(ACCESSIBILITY_POLICY_SETTINGS.every((s) => s.category === 'Accessibility')).toBe(true);
  });

  it('uses the labels users see in their settings', () => {
    for (const setting of ACCESSIBILITY_POLICY_SETTINGS) {
      expect(setting.labelKey, setting.key).toBeTruthy();
      expect(setting.label, setting.key).toBe(lookup(setting.labelKey!));
    }
  });

  it('offers exactly the values each option accepts', () => {
    for (const setting of ACCESSIBILITY_POLICY_SETTINGS) {
      const allowed = ACCESSIBILITY_ALLOWED[setting.key];
      if (!allowed) continue;
      expect(setting.type, setting.key).toBe('enum');
      expect(new Set(setting.options!.map((o) => o.value)), setting.key).toEqual(new Set(allowed));
    }
  });
});

describe('every setting the defaults editor offers', () => {
  it('has the build default the settings store starts with', () => {
    for (const setting of PRESETTABLE_SETTINGS) {
      expect(setting.defaultValue, setting.key).toEqual(builtIn[setting.key]);
    }
  });

  it('only offers values the store applies as a default', () => {
    for (const setting of PRESETTABLE_SETTINGS) {
      for (const option of setting.options ?? []) {
        expect(applied(setting.key, { defaults: { [setting.key]: option.value } }), `${setting.key}=${String(option.value)}`).toEqual(option.value);
      }
    }
    // And a value it doesn't know is not applied.
    expect(applied('contrast', { defaults: { contrast: 'max' } })).toBeUndefined();
  });
});

describe('the lock list (lib/admin/restriction-keys.ts)', () => {
  const policyKeys = restrictionKeysForPage('policy');

  it('offers no lock for text size, contrast, motion, fonts or reading aids', () => {
    for (const def of RESTRICTION_KEYS) {
      const modes = def.modes ?? ['locked', 'hidden'];
      if (UNLOCKABLE_SETTING_KEYS.has(def.key)) expect(modes, def.key).not.toContain('locked');
    }
    const accessibility = policyKeys.filter((def) => def.category === 'Accessibility').map((def) => def.key);
    expect(accessibility.sort()).toEqual(['sendConfirmation', 'singleKeyShortcuts', 'toastDuration']);
    expect(policyKeys.find((def) => def.key === 'toastDuration')?.modes).toEqual(['min']);
  });

  it('has the store\'s defaults and values', () => {
    for (const def of policyKeys) {
      expect(def.defaultValue, def.key).toEqual(builtIn[def.key]);
      for (const value of def.allowedValues ?? []) {
        expect(applied(def.key, { restrictions: { [def.key]: { locked: true, value } } }), `${def.key}=${value}`).toBe(value);
      }
    }
  });

  it('lists the values of the store\'s types', () => {
    // The store checks only the type of these, so the list has to match
    // the unions in stores/settings-store.ts by hand.
    const expected: Record<string, string[]> = {
      density: ['extra-compact', 'compact', 'regular', 'comfortable'],
      interfaceLayout: ['default', 'mountain-view'],
      deleteAction: ['trash', 'trash-and-read', 'permanent'],
      mailLayout: ['split', 'focus', 'horizontal'],
      externalContentPolicy: ['ask', 'block', 'allow'],
      searchDefaultScope: ['all', 'folder'],
      defaultReplyMode: ['reply', 'replyAll'],
      replyIdentityMatch: ['exact', 'domain'],
    };
    for (const def of policyKeys.filter((d) => d.type === 'enum')) {
      expect(new Set(def.allowedValues), def.key).toEqual(new Set(expected[def.key]));
    }
  });

  it('a lock with a value sets it for everyone; a minimum raises nothing in the store', () => {
    expect(applied('singleKeyShortcuts', { restrictions: { singleKeyShortcuts: { locked: true, value: false } } }, true)).toBe(false);
    expect(applied('toastDuration', { restrictions: { toastDuration: { min: 20 } }, defaults: { toastDuration: 5 } }, 10)).toBeUndefined();
  });
});

const policy = (patch: Partial<SettingsPolicy> = {}): SettingsPolicy => ({
  ...DEFAULT_POLICY,
  restrictions: {},
  defaults: {},
  scopes: [{ id: 'team', label: 'Team', match: { groups: ['team@example.org'] }, policy: {} }],
  ...patch,
});

describe('edits at a scope', () => {
  it('locks for Everyone with a value and drops the value with the lock', () => {
    let p = withRestrictionAt(policy(), '', 'singleKeyShortcuts', { locked: true, value: false });
    expect(p.restrictions.singleKeyShortcuts).toEqual({ locked: true, value: false });
    p = withRestrictionAt(p, '', 'sendConfirmation', { hidden: true });
    p = withRestrictionAt(p, '', 'sendConfirmation', { hidden: true, locked: true, value: true });
    p = withRestrictionAt(p, '', 'sendConfirmation', { ...p.restrictions.sendConfirmation, locked: false });
    expect(p.restrictions.sendConfirmation).toEqual({ hidden: true });
    p = withRestrictionAt(p, '', 'singleKeyShortcuts', { locked: false });
    expect(p.restrictions).not.toHaveProperty('singleKeyShortcuts');
  });

  it('keeps a minimum without a lock', () => {
    const p = withRestrictionAt(policy(), '', 'toastDuration', { min: 20 });
    expect(p.restrictions.toastDuration).toEqual({ min: 20 });
    expect(withRestrictionAt(p, '', 'toastDuration', { min: undefined }).restrictions).not.toHaveProperty('toastDuration');
  });

  it('writes a scope\'s own lock, unlocks with {} and inherits again', () => {
    let p = withRestrictionAt(policy(), '', 'singleKeyShortcuts', { locked: true, value: false });
    expect(restrictionAt(p, 'team', 'singleKeyShortcuts')).toEqual({ value: { locked: true, value: false }, own: false, everyone: { locked: true, value: false } });
    p = withRestrictionAt(p, 'team', 'singleKeyShortcuts', { locked: false, value: false });
    expect(p.scopes![0].policy.restrictions).toEqual({ singleKeyShortcuts: {} });
    expect(p.restrictions.singleKeyShortcuts).toEqual({ locked: true, value: false });
    p = withRestrictionAt(p, 'team', 'singleKeyShortcuts', undefined);
    expect(p.scopes![0].policy.restrictions).toEqual({});
  });

  it('sets and removes defaults for Everyone and for a scope', () => {
    let p = withDefaultAt(policy(), '', 'fontSize', 'large');
    expect(p.defaults).toEqual({ fontSize: 'large' });
    expect(defaultAt(p, 'team', 'fontSize')).toEqual({ value: 'large', own: false, everyone: 'large' });
    p = withDefaultAt(p, 'team', 'fontSize', 'huge');
    expect(p.scopes![0].policy.defaults).toEqual({ fontSize: 'huge' });
    expect(effectiveDefault(p, 'team', 'fontSize')).toBe('huge');
    expect(effectiveDefault(p, '', 'contrast')).toBe('system');
    p = withDefaultAt(p, 'team', 'fontSize', undefined);
    expect(defaultAt(p, 'team', 'fontSize').own).toBe(false);
    expect(p.defaults).toEqual({ fontSize: 'large' });
  });

  it('finds presets the editor has no row for, and reads typed values', () => {
    const p = policy({ defaults: { fontSize: 'large', dateFormat: 'iso' } });
    expect(otherDefaultKeys(p, '')).toEqual(['dateFormat']);
    expect(parseFreeSettingValue('true')).toBe(true);
    expect(parseFreeSettingValue('12')).toBe(12);
    expect(parseFreeSettingValue('iso')).toBe('iso');
  });
});
