/**
 * The settings an admin can preset (policy `defaults`) and lock with a value
 * (restriction `value` / `min`) on the User policy page, and the pure edits
 * the page makes to a policy, for Everyone or for one domain or group scope.
 *
 * Labels are the ones users see in their own settings (English, like the
 * rest of the admin panel), so the admin and the user talk about the same
 * thing. lib/admin/__tests__/policy-settings.test.ts checks them against
 * locales/en/common.json and the defaults against the settings store.
 */

import type { SettingRestriction, SettingsPolicy } from './types';
import { RESTRICTION_KEYS } from './restriction-keys';
import {
  ACCESSIBILITY_DEFAULTS,
  FONT_SIZES,
  MAIL_MIN_FONT_SIZES,
  MAIL_TEXT_SCALES,
  READ_ALOUD_RATES,
  TOAST_DURATIONS,
  UNLOCKABLE_SETTING_KEYS,
} from '@/lib/accessibility-settings';

export type PolicySettingValue = boolean | number | string;

export interface PolicySettingOption {
  value: PolicySettingValue;
  label: string;
}

export interface PresettableSetting {
  key: string;
  label: string;
  category: string;
  /** Sub-heading inside the category (the Accessibility page's sections). */
  group?: string;
  type: 'boolean' | 'number' | 'enum' | 'text';
  options?: PolicySettingOption[];
  /** The build's default, what users get when nothing is preset. */
  defaultValue: PolicySettingValue;
  /** Where the label comes from in locales/<code>/common.json (checked by a test). */
  labelKey?: string;
}

const A = 'settings.accessibility';
const SYSTEM_ON_OFF: PolicySettingOption[] = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];
const FONT_SIZE_LABELS: Record<string, string> = {
  small: '87.5%', medium: '100%', large: '112.5%', 'x-large': '125%', 'xx-large': '150%', 'xxx-large': '175%', huge: '200%',
};
const COMPOSE_FONT_SIZES = ['14px', '16px', '18px', '20px', '24px', '32px'];

type Entry = Omit<PresettableSetting, 'category' | 'defaultValue'> & { defaultValue?: PolicySettingValue };

function group(name: string, entries: Entry[]): PresettableSetting[] {
  return entries.map((entry) => ({
    category: 'Accessibility',
    group: name,
    defaultValue: (ACCESSIBILITY_DEFAULTS as unknown as Record<string, PolicySettingValue>)[entry.key],
    ...entry,
  } as PresettableSetting));
}

/**
 * Every option on Settings > Accessibility that is the accessibility
 * page's own (ACCESSIBILITY_KEYS plus text size), and Confirm before
 * sending, which lives there too. In the order and sections users see.
 */
export const ACCESSIBILITY_POLICY_SETTINGS: readonly PresettableSetting[] = [
  ...group('Accessibility button', [
    { key: 'showAccessibilityButton', label: 'Accessibility button in the navigation bar', type: 'boolean', labelKey: `${A}.quick_button.label` },
  ]),
  ...group('Text and reading', [
    {
      key: 'fontSize', label: 'Text size', type: 'enum', labelKey: `${A}.text_size.label`, defaultValue: 'medium',
      options: FONT_SIZES.map((size) => ({ value: size, label: FONT_SIZE_LABELS[size] })),
    },
    {
      key: 'appFont', label: 'Font', type: 'enum', labelKey: `${A}.font.label`,
      options: [
        { value: 'default', label: 'Theme font' },
        { value: 'atkinson', label: 'Atkinson Hyperlegible' },
        { value: 'lexend', label: 'Lexend' },
        { value: 'opendyslexic', label: 'OpenDyslexic' },
      ],
    },
    {
      key: 'lineSpacing', label: 'Line spacing', type: 'enum', labelKey: `${A}.line_spacing.label`,
      options: [{ value: 'normal', label: 'Normal' }, { value: 'relaxed', label: 'More' }, { value: 'loose', label: 'Most' }],
    },
    {
      key: 'letterSpacing', label: 'Letter spacing', type: 'enum', labelKey: `${A}.letter_spacing.label`,
      options: [{ value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }, { value: 'wider', label: 'Wider' }],
    },
    {
      key: 'wordSpacing', label: 'Word spacing', type: 'enum', labelKey: `${A}.word_spacing.label`,
      options: [{ value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }],
    },
    {
      key: 'paragraphSpacing', label: 'Paragraph spacing', type: 'enum', labelKey: `${A}.paragraph_spacing.label`,
      options: [{ value: 'normal', label: 'Normal' }, { value: 'wide', label: 'Wide' }],
    },
    {
      key: 'readingWidth', label: 'Reading width', type: 'enum', labelKey: `${A}.reading_width.label`,
      options: [{ value: 'full', label: 'Full width' }, { value: 'comfortable', label: 'About 80 characters' }],
    },
    { key: 'readingMask', label: 'Reading mask', type: 'boolean', labelKey: `${A}.reading_mask.label` },
    { key: 'plainLanguage', label: 'Plain language', type: 'boolean', labelKey: `${A}.plain_language.label` },
  ]),
  ...group('Colour and contrast', [
    {
      key: 'contrast', label: 'Contrast', type: 'enum', labelKey: `${A}.contrast.label`,
      options: [{ value: 'system', label: 'System' }, { value: 'more', label: 'More' }, { value: 'normal', label: 'Normal' }],
    },
    { key: 'reduceTransparency', label: 'Reduce transparency', type: 'enum', options: SYSTEM_ON_OFF, labelKey: `${A}.transparency.label` },
    { key: 'underlineLinks', label: 'Underline links', type: 'boolean', labelKey: `${A}.underline_links.label` },
    { key: 'showColorNames', label: 'Show names next to colours', type: 'boolean', labelKey: `${A}.color_names.label` },
    { key: 'colorBlindPalette', label: 'Colour-blind-safe colours', type: 'boolean', labelKey: `${A}.cvd_palette.label` },
  ]),
  ...group('Motion', [
    { key: 'reduceMotion', label: 'Reduce motion', type: 'enum', options: SYSTEM_ON_OFF, labelKey: `${A}.reduce_motion.label` },
    { key: 'pauseAnimatedImages', label: 'Pause animated images', type: 'enum', options: SYSTEM_ON_OFF, labelKey: `${A}.pause_images.label` },
  ]),
  ...group('Keyboard and focus', [
    { key: 'singleKeyShortcuts', label: 'Single-key shortcuts', type: 'boolean', labelKey: `${A}.single_key_shortcuts.label` },
    {
      key: 'focusRing', label: 'Focus outline', type: 'enum', labelKey: `${A}.focus_ring.label`,
      options: [{ value: 'normal', label: 'Normal' }, { value: 'thick', label: 'Thick' }, { value: 'extra', label: 'Extra thick' }],
    },
    { key: 'focusAlwaysVisible', label: 'Always show focus', type: 'boolean', labelKey: `${A}.focus_always.label` },
  ]),
  ...group('Pointer and touch', [
    { key: 'largeTargets', label: 'Large targets', type: 'enum', options: SYSTEM_ON_OFF, labelKey: `${A}.large_targets.label` },
    { key: 'largeCursor', label: 'Large mouse pointer', type: 'boolean', labelKey: `${A}.large_cursor.label` },
    { key: 'openOnHover', label: 'Open on hover', type: 'boolean', labelKey: `${A}.open_on_hover.label` },
    { key: 'showRowActionButton', label: 'Actions button on each message', type: 'boolean', labelKey: `${A}.row_action_button.label` },
    { key: 'nativeScrollbars', label: 'Wider scrollbars', type: 'boolean', labelKey: `${A}.native_scrollbars.label` },
  ]),
  ...group('Mail', [
    {
      key: 'mailViewMode', label: 'Show messages as', type: 'enum', labelKey: `${A}.mail_view.label`,
      options: [{ value: 'html', label: 'Formatted' }, { value: 'plain', label: 'Plain text' }],
    },
    {
      key: 'mailTextScale', label: 'Message text size', type: 'enum', labelKey: `${A}.mail_text_size.label`,
      options: MAIL_TEXT_SCALES.map((scale) => ({ value: scale, label: scale === 0 ? 'Same as the app' : `${Math.round(scale * 100)} %` })),
    },
    {
      key: 'mailMinFontSize', label: 'Smallest text in messages', type: 'enum', labelKey: `${A}.mail_min_font_size.label`,
      options: MAIL_MIN_FONT_SIZES.map((size) => ({ value: size, label: size === 0 ? 'No minimum' : `${size} px` })),
    },
    {
      key: 'mailOverrideStyles', label: 'Use my font and colours in messages', type: 'enum', labelKey: `${A}.mail_override.label`,
      options: [{ value: 'never', label: 'Never' }, { value: 'high-contrast', label: 'With more contrast' }, { value: 'always', label: 'Always' }],
    },
    { key: 'mailFitWidth', label: 'Fit wide messages to the window', type: 'boolean', labelKey: `${A}.mail_fit_width.label` },
    {
      key: 'readAloudRate', label: 'Read aloud speed', type: 'enum', labelKey: `${A}.read_aloud_rate.label`,
      options: READ_ALOUD_RATES.map((rate) => ({ value: rate, label: `${rate}×` })),
    },
    { key: 'readAloudVoice', label: 'Read aloud voice', type: 'text', labelKey: `${A}.read_aloud_voice.label` },
    {
      key: 'composeFontFamily', label: 'Font for new messages', type: 'enum', labelKey: `${A}.compose_font.label`,
      options: [
        { value: '', label: 'Default' },
        { value: 'sans-serif', label: 'Sans serif' },
        { value: 'serif', label: 'Serif' },
        { value: 'monospace', label: 'Monospace' },
      ],
    },
    {
      key: 'composeFontSize', label: 'Text size for new messages', type: 'enum', labelKey: `${A}.compose_size.label`,
      options: [{ value: '', label: 'Default' }, ...COMPOSE_FONT_SIZES.map((size) => ({ value: size, label: size }))],
    },
  ]),
  ...group('Timing and mistakes', [
    {
      key: 'toastDuration', label: 'Notification duration', type: 'enum', labelKey: `${A}.toast_duration.label`,
      options: TOAST_DURATIONS.map((seconds) => ({ value: seconds, label: seconds === 0 ? 'Until I close them' : `${seconds} seconds` })),
    },
    { key: 'sendConfirmation', label: 'Confirm before sending', type: 'boolean', labelKey: `${A}.confirm_send.label`, defaultValue: false },
    { key: 'confirmDelete', label: 'Confirm before deleting', type: 'boolean', labelKey: `${A}.confirm_delete.label` },
    { key: 'confirmArchive', label: 'Confirm before archiving', type: 'boolean', labelKey: `${A}.confirm_archive.label` },
  ]),
  ...group('Alerts and distractions', [
    { key: 'visualAlerts', label: 'Visual alerts', type: 'boolean', labelKey: `${A}.visual_alerts.label` },
    {
      key: 'unreadCountStyle', label: 'Unread counts', type: 'enum', labelKey: `${A}.unread_counts.label`,
      options: [{ value: 'count', label: 'Number' }, { value: 'dot', label: 'Dot' }, { value: 'hidden', label: 'Hidden' }],
    },
    { key: 'doNotDisturb', label: 'Do not disturb', type: 'boolean', labelKey: `${A}.do_not_disturb.label` },
  ]),
  ...group('Screen readers', [
    { key: 'announceNewMail', label: 'Announce new mail', type: 'boolean', labelKey: `${A}.announce_new_mail.label` },
    { key: 'announceRowPreview', label: 'Read the preview in the list', type: 'boolean', labelKey: `${A}.announce_preview.label` },
    { key: 'simpleMode', label: 'Simple mode', type: 'boolean', labelKey: `${A}.simple_mode.label` },
    { key: 'simpleModePagedList', label: 'Page through the message list', type: 'boolean', labelKey: `${A}.simple_mode_paged.label` },
  ]),
];

/** Readable choices for restriction keys whose values are numbers with a meaning. */
const RESTRICTION_KEY_OPTIONS: Record<string, PolicySettingOption[]> = {
  markAsReadDelay: [
    { value: 0, label: 'Instantly' },
    { value: 3000, label: 'After 3 seconds' },
    { value: 5000, label: 'After 5 seconds' },
    { value: -1, label: 'Never' },
  ],
  searchDefaultScope: [
    { value: 'all', label: 'All folders except Spam and Trash' },
    { value: 'folder', label: 'The open folder' },
  ],
};

const accessibilityKeys = new Set(ACCESSIBILITY_POLICY_SETTINGS.map((s) => s.key));

/**
 * Everything the defaults editor lists: the Accessibility options, then the
 * other settings of the User policy page's lock list, by category.
 */
export const PRESETTABLE_SETTINGS: readonly PresettableSetting[] = [
  ...ACCESSIBILITY_POLICY_SETTINGS,
  ...RESTRICTION_KEYS
    .filter((def) => def.page === 'policy' && !accessibilityKeys.has(def.key) && def.defaultValue !== undefined)
    .map((def): PresettableSetting => {
      const options = RESTRICTION_KEY_OPTIONS[def.key]
        ?? def.allowedValues?.map((value) => ({ value, label: value }));
      return {
        key: def.key,
        label: def.label,
        category: def.category,
        type: options ? 'enum' : def.type === 'enum' ? 'text' : def.type,
        options,
        defaultValue: def.defaultValue as PolicySettingValue,
      };
    }),
];

const BY_KEY = new Map(PRESETTABLE_SETTINGS.map((s) => [s.key, s]));

export function presettableSetting(key: string): PresettableSetting | undefined {
  return BY_KEY.get(key);
}

/**
 * Whether the admin panel offers a lock for `key`. Text size, contrast,
 * motion, fonts and the reading aids can only be preset.
 */
export function isLockableSetting(key: string): boolean {
  return !UNLOCKABLE_SETTING_KEYS.has(key);
}

/** "On", "Large", "20 seconds": a value as the admin reads it. */
export function describeSettingValue(key: string, value: unknown): string {
  const def = presettableSetting(key);
  const option = def?.options?.find((o) => o.value === value);
  if (option) return option.label;
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (value === '' || value === undefined) return 'not set';
  return String(value);
}

/**
 * Turns what the admin typed for a setting the editor has no input for into
 * a policy value: true/false, a number, or the text as it is.
 */
export function parseFreeSettingValue(text: string): PolicySettingValue {
  const trimmed = text.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return text;
}

// ---------------------------------------------------------------------------
// Edits at a scope. '' is Everyone (the global policy); any other id is one
// of policy.scopes. A scope value replaces Everyone's per key; removing it
// in a scope means "use Everyone's" again.
// ---------------------------------------------------------------------------

export const EVERYONE_SCOPE = '';

export interface ScopedValue<T> {
  /** What applies at the scope: its own value, or Everyone's. */
  value: T;
  /** The scope sets it itself (always true for Everyone when set at all). */
  own: boolean;
  /** Everyone's value. */
  everyone: T;
}

function clonePolicy(policy: SettingsPolicy): SettingsPolicy {
  return JSON.parse(JSON.stringify(policy)) as SettingsPolicy;
}

function scopeOf(policy: SettingsPolicy, scopeId: string) {
  return scopeId === EVERYONE_SCOPE ? null : (policy.scopes ?? []).find((s) => s.id === scopeId) ?? null;
}

const hasOwn = (obj: object | undefined, key: string) => !!obj && Object.prototype.hasOwnProperty.call(obj, key);

export function restrictionAt(policy: SettingsPolicy, scopeId: string, key: string): ScopedValue<SettingRestriction | undefined> {
  const everyone = policy.restrictions?.[key];
  const scope = scopeOf(policy, scopeId);
  if (!scope) return { value: everyone, own: everyone !== undefined, everyone };
  const restrictions = scope.policy.restrictions;
  return hasOwn(restrictions, key)
    ? { value: restrictions![key], own: true, everyone }
    : { value: everyone, own: false, everyone };
}

function isEmptyRestriction(r: SettingRestriction | undefined): boolean {
  return !r || (!r.locked && !r.hidden && !r.allowedValues?.length && r.min === undefined && r.max === undefined);
}

/**
 * The policy with `key`'s restriction set at the scope. `undefined` removes
 * it (in a scope: back to Everyone's); an empty restriction in a scope is
 * kept as `{}`, which unlocks what Everyone locks. A restriction that is no
 * longer locked drops its value, so an old value can't come back with the
 * next lock.
 */
export function withRestrictionAt(
  policy: SettingsPolicy,
  scopeId: string,
  key: string,
  restriction: SettingRestriction | undefined,
): SettingsPolicy {
  const next = clonePolicy(policy);
  let value = restriction ? { ...restriction } : undefined;
  if (value && !value.locked) {
    delete value.locked;
    delete value.value;
  }
  if (value && !value.hidden) delete value.hidden;
  if (value && value.min === undefined) delete value.min;
  const empty = isEmptyRestriction(value);
  if (empty && value) value = {};
  const scope = scopeOf(next, scopeId);
  if (!scope) {
    next.restrictions = { ...(next.restrictions ?? {}) };
    if (!value || empty) delete next.restrictions[key];
    else next.restrictions[key] = value;
    return next;
  }
  const restrictions = (scope.policy.restrictions ??= {});
  if (value === undefined) delete restrictions[key];
  else restrictions[key] = value;
  return next;
}

export function defaultAt(policy: SettingsPolicy, scopeId: string, key: string): ScopedValue<unknown> {
  const everyone = hasOwn(policy.defaults, key) ? policy.defaults[key] : undefined;
  const scope = scopeOf(policy, scopeId);
  if (!scope) return { value: everyone, own: everyone !== undefined, everyone };
  const defaults = scope.policy.defaults;
  return hasOwn(defaults, key)
    ? { value: defaults![key], own: true, everyone }
    : { value: everyone, own: false, everyone };
}

/** The policy with `key` preset to `value` at the scope; `undefined` removes the preset. */
export function withDefaultAt(policy: SettingsPolicy, scopeId: string, key: string, value: PolicySettingValue | undefined): SettingsPolicy {
  const next = clonePolicy(policy);
  const scope = scopeOf(next, scopeId);
  const target = scope ? (scope.policy.defaults ??= {}) : (next.defaults = { ...(next.defaults ?? {}) });
  if (value === undefined) delete target[key];
  else target[key] = value;
  return next;
}

/** Keys preset at the scope (its own, not Everyone's) that the editor has no row for. */
export function otherDefaultKeys(policy: SettingsPolicy, scopeId: string): string[] {
  const scope = scopeOf(policy, scopeId);
  const defaults = scope ? scope.policy.defaults ?? {} : policy.defaults ?? {};
  return Object.keys(defaults).filter((key) => !BY_KEY.has(key));
}

/**
 * What users get for `key` at the scope when nothing else applies: the
 * preset (the scope's or Everyone's), else the build default.
 */
export function effectiveDefault(policy: SettingsPolicy, scopeId: string, key: string): unknown {
  const preset = defaultAt(policy, scopeId, key).value;
  return preset !== undefined ? preset : presettableSetting(key)?.defaultValue;
}
