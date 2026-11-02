// Area c, settings: app.describeSettings, app.setSettings and
// app.undoSettings over the allow-list in lib/settings-schema.ts.
//
// A change is checked at the moment it is made, the way the settings page
// would show it: the key must be in the allow-list, the value one the
// setting may take there, the row must be shown (its feature gate, its
// page's gate, no-third-party mode, the admin's hidden flag), not locked by
// the admin and within the admin's restriction. It is written through the
// same setters the pages use (updateSetting, setTheme, setLocale,
// setViewMode), so plugin hooks run, the open page shows it and it syncs;
// then it is read back, since another plugin may have stopped it.

import { useSettingsStore } from '@/stores/settings-store';
import { useThemeStore } from '@/stores/theme-store';
import { useLocaleStore } from '@/stores/locale-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { usePolicyStore } from '@/stores/policy-store';
import { settingsHooks } from '../../plugin-hooks';
import { noThirdPartyTraffic } from '../../third-party-mode';
import { toastDurationAtLeast } from '../../accessibility-settings';
import { detectBrowserLocale } from '@/i18n/detect-locale';
import { getByPath } from '../../settings-search';
import {
  DENIED_SETTINGS, PAGE_GATES, SETTINGS_SCHEMA, isAllowedSettingValue, settingValueLabelKey,
  type SettingSchemaEntry,
} from '../../settings-schema';
import { isPlainRecord, sessionClient } from '../host-api-input';
import { messagesFor } from '../host-api-app';
import { issueUndoToken, redeemUndoToken, undoAccount } from './c.undo';
import type {
  SettingDescription, SettingRefusal, SettingValue, SettingsChangeResult, SettingsUndoResult,
} from './c.types';

/** Most settings one call names. */
export const MAX_PLUGIN_SETTINGS = 20;
/** How long a change may wait for another plugin's onBeforeSettingChange. */
const VETO_WAIT_MS = 3000;

type Messages = Record<string, unknown>;

export function currentSettingValue(entry: SettingSchemaEntry): SettingValue | null {
  let value: unknown;
  switch (entry.store) {
    case 'theme': value = (useThemeStore.getState() as unknown as { theme?: unknown }).theme; break;
    case 'locale': value = useLocaleStore.getState().locale; break;
    case 'calendar': value = useCalendarStore.getState().viewMode; break;
    default: value = (useSettingsStore.getState() as unknown as Record<string, unknown>)[entry.key];
  }
  if (Array.isArray(value)) return [...value] as SettingValue;
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * app.getSettings names two settings after what they mean to a reader
 * (language, calendarView); setSettings takes those names too.
 */
const SETTING_ALIASES: Readonly<Record<string, string>> = { language: 'locale', calendarView: 'viewMode' };
export const canonicalSetting = (name: string): string => SETTING_ALIASES[name] ?? name;
const schemaEntry = (key: string): SettingSchemaEntry | undefined => (Object.prototype.hasOwnProperty.call(SETTINGS_SCHEMA, key) ? SETTINGS_SCHEMA[key] : undefined);

function gateOn(gate: Parameters<ReturnType<typeof usePolicyStore.getState>['isFeatureEnabled']>[0]): boolean {
  try { return usePolicyStore.getState().isFeatureEnabled(gate); } catch { return true; }
}

/**
 * Why `key` can't be changed (to `value`, when given) right now, or null.
 * `pending` holds the other values of the same call (calendar hours are
 * checked against each other).
 */
export function settingRefusal(name: string, value?: unknown, pending: Record<string, unknown> = {}): SettingRefusal | null {
  const key = canonicalSetting(name);
  const entry = schemaEntry(key);
  if (!entry) return DENIED_SETTINGS.includes(key) || key in (useSettingsStore.getState() as object) ? 'not_allowed' : 'unknown';
  const policy = usePolicyStore.getState();
  if (entry.gate && !gateOn(entry.gate)) return 'unavailable';
  const pageGate = PAGE_GATES[entry.page];
  if (pageGate && !gateOn(pageGate)) return 'unavailable';
  if (entry.thirdParty && noThirdPartyTraffic()) return 'unavailable';
  if (entry.store === 'settings' && policy.isSettingHidden(key)) return 'hidden';
  if (entry.store === 'settings' && policy.isSettingLocked(key) && !entry.preset) return 'locked';
  if (entry.store === 'theme' && policy.getColorModePolicy().locked) return 'locked';
  if (value === undefined) return null;
  if (!isAllowedSettingValue(entry, value)) return 'bad_value';
  if (entry.kind.type === 'choice' || entry.kind.type === 'list') {
    const values = Array.isArray(value) ? value : [value];
    const gated = entry.kind.options.filter((o) => o.gate && !gateOn(o.gate));
    if (gated.some((o) => values.includes(o.value))) return 'unavailable';
  }
  const restricted = restrictionRefusal(entry, value);
  if (restricted) return restricted;
  if (key === 'calendarDayStartHour' || key === 'calendarDayEndHour') {
    const state = useSettingsStore.getState();
    const start = Number(key === 'calendarDayStartHour' ? value : pending.calendarDayStartHour ?? state.calendarDayStartHour);
    const end = Number(key === 'calendarDayEndHour' ? value : pending.calendarDayEndHour ?? state.calendarDayEndHour);
    if (!(end > start)) return 'bad_value';
  }
  return null;
}

/** The admin's restriction on the value (allowed values, minimum, maximum), or null. */
function restrictionRefusal(entry: SettingSchemaEntry, value: unknown): SettingRefusal | null {
  const key = entry.key;
  const restriction = entry.store === 'settings' ? usePolicyStore.getState().getRestriction(key) : undefined;
  if (!restriction) return null;
  if (restriction.allowedValues && !restriction.allowedValues.some((v) => same(v, value))) return 'bad_value';
  if (typeof value === 'number') {
    if (key === 'toastDuration' && typeof restriction.min === 'number') {
      if (!toastDurationAtLeast(value, restriction.min)) return 'bad_value';
    } else if (typeof restriction.min === 'number' && value < restriction.min) return 'bad_value';
    if (typeof restriction.max === 'number' && value > restriction.max) return 'bad_value';
  }
  return null;
}

function format(messages: Messages, key: string, params: Record<string, string> = {}): string | null {
  const raw = getByPath(messages, key);
  if (typeof raw !== 'string') return null;
  return raw.replace(/\{(\w+)\}/g, (all, name: string) => params[name] ?? all);
}

function userLocale(): string {
  return useLocaleStore.getState().locale || detectBrowserLocale('en');
}

/** A value in the user's words: the page's own label, else a formatted value. */
export function settingValueLabel(entry: SettingSchemaEntry, value: unknown, messages: Messages, locale = userLocale()): string {
  if (value === null || value === undefined) return '';
  const key = settingValueLabelKey(entry, value);
  if (key) {
    const zone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return 'UTC'; } })();
    const text = format(messages, key, { zone });
    if (text) return text;
  }
  const kind = entry.kind;
  if ((kind.type === 'choice' || kind.type === 'list')) {
    const label = (v: unknown) => {
      const option = kind.options.find((o) => o.value === v);
      return (option?.label && format(messages, option.label)) || option?.text || String(v);
    };
    return Array.isArray(value) ? value.map(label).join(', ') : label(value);
  }
  if (kind.type === 'hour' && typeof value === 'number') return `${String(value).padStart(2, '0')}:00`;
  if (kind.type === 'days' && Array.isArray(value)) {
    // 2023-01-01 was a Sunday (day 0).
    return value.map((d) => {
      try { return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + Number(d)))); } catch { return String(d); }
    }).join(', ');
  }
  if (kind.type === 'locale' && typeof value === 'string' && value && value !== 'auto') {
    try { return new Intl.DisplayNames([value], { type: 'language' }).of(value) ?? value; } catch { return value; }
  }
  return Array.isArray(value) ? value.join(', ') : String(value);
}

function readChanges(arg: unknown, method: string): Record<string, unknown> {
  if (!isPlainRecord(arg)) throw new Error(`${method}: changes must be an object of setting names and values`);
  const keys = Object.keys(arg);
  if (keys.length === 0 || keys.length > MAX_PLUGIN_SETTINGS) throw new Error(`${method}: name 1 to ${MAX_PLUGIN_SETTINGS} settings`);
  return arg;
}

/**
 * The settings named, in the user's language: label, page, current value
 * and, for a change, the new one, and whether it may be made now. `arg` is
 * an object of changes or an array of setting names.
 */
export async function doDescribeSettings(arg: unknown): Promise<Record<string, SettingDescription>> {
  const method = 'app.describeSettings';
  const changes: Record<string, unknown> = Array.isArray(arg)
    ? Object.fromEntries(arg.slice(0, MAX_PLUGIN_SETTINGS + 1).map((k) => [String(k), undefined]))
    : readChanges(arg, method);
  if (Object.keys(changes).length === 0 || Object.keys(changes).length > MAX_PLUGIN_SETTINGS) {
    throw new Error(`${method}: name 1 to ${MAX_PLUGIN_SETTINGS} settings`);
  }
  const locale = userLocale();
  const messages = await messagesFor(locale);
  const out: Record<string, SettingDescription> = {};
  for (const [key, next] of Object.entries(changes)) {
    if (key.length > 100) continue;
    const reason = settingRefusal(key, next, changes);
    const entry = schemaEntry(canonicalSetting(key));
    if (!entry) {
      out[key] = { key, label: key, page: '', pageLabel: '', current: null, currentLabel: '', allowed: false, reason: reason ?? 'unknown' };
      continue;
    }
    const current = currentSettingValue(entry);
    const options = entry.kind.type === 'choice' || entry.kind.type === 'boolean'
      ? (entry.kind.type === 'boolean' ? [true, false] : entry.kind.options.map((o) => o.value))
        .filter((v) => settingRefusal(entry.key, v, changes) === null)
        .map((v) => ({ value: v, label: settingValueLabel(entry, v, messages, locale) }))
      : undefined;
    out[key] = {
      key,
      label: format(messages, entry.label) ?? key,
      page: entry.page,
      pageLabel: format(messages, `settings.tabs.${entry.page}`) ?? entry.page,
      current,
      currentLabel: settingValueLabel(entry, current, messages, locale),
      ...(next !== undefined ? { next: next as SettingValue, nextLabel: settingValueLabel(entry, next, messages, locale) } : {}),
      allowed: reason === null,
      ...(reason ? { reason } : {}),
      ...(options && options.length ? { options } : {}),
    };
  }
  return out;
}

/** Writes one value through the setter the settings page uses. */
function write(entry: SettingSchemaEntry, value: unknown): void {
  switch (entry.store) {
    case 'theme': useThemeStore.getState().setTheme(value as 'light' | 'dark' | 'system'); return;
    case 'locale': useLocaleStore.getState().setLocale(value as string); return;
    case 'calendar': useCalendarStore.getState().setViewMode(value as never); return;
    default: useSettingsStore.getState().updateSetting(entry.key as never, value as never);
  }
}

/** Writes and reads back: false when the value didn't stick (another plugin stopped it). */
async function writeAndCheck(entry: SettingSchemaEntry, value: unknown): Promise<boolean> {
  write(entry, value);
  if (same(currentSettingValue(entry), value)) return true;
  // With another plugin's onBeforeSettingChange the store applies the change
  // once that plugin answered, or never.
  if (entry.store !== 'settings' || settingsHooks.onBeforeSettingChange.size === 0) return false;
  const until = Date.now() + VETO_WAIT_MS;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (same(currentSettingValue(entry), value)) return true;
  }
  return false;
}

/**
 * Change settings for the user. Each key is checked and written on its own;
 * the result says which were applied (old and new value) and which were
 * refused and why, plus a token for app.undoSettings.
 */
export async function doSetSettings(pluginId: string, arg: unknown): Promise<SettingsChangeResult> {
  const method = 'app.setSettings';
  const changes = readChanges(arg, method);
  const client = sessionClient(method);
  const applied: SettingsChangeResult['applied'] = {};
  const refused: SettingsChangeResult['refused'] = {};
  const previous: Record<string, SettingValue | null> = {};
  for (const [key, value] of Object.entries(changes)) {
    const reason = settingRefusal(key, value, changes);
    if (reason) { refused[key] = reason; continue; }
    const entry = SETTINGS_SCHEMA[canonicalSetting(key)];
    const old = currentSettingValue(entry);
    if (same(old, value)) { applied[key] = { old, new: value as SettingValue }; continue; }
    if (!(await writeAndCheck(entry, value))) { refused[key] = 'stopped'; continue; }
    applied[key] = { old, new: value as SettingValue };
    previous[entry.key] = old;
  }
  const undoToken = Object.keys(previous).length > 0
    ? issueUndoToken(pluginId, undoAccount(client), 'settings', previous)
    : null;
  return { applied, refused, undoToken };
}

/**
 * Put back what app.setSettings changed: the exact old value, even one the
 * allow-list wouldn't offer (the user chose it), but not where the admin
 * has locked the setting since.
 */
export async function doUndoSettings(pluginId: string, token: unknown): Promise<SettingsUndoResult> {
  const method = 'app.undoSettings';
  const client = sessionClient(method);
  const previous = redeemUndoToken<Record<string, SettingValue | null>>(method, pluginId, undoAccount(client), 'settings', token);
  const restored: string[] = [];
  const refused: SettingsUndoResult['refused'] = {};
  for (const [key, old] of Object.entries(previous)) {
    const entry = schemaEntry(key);
    if (!entry || old === null) { refused[key] = 'unknown'; continue; }
    // As for a change: not where the admin has locked or hidden the setting
    // since, a gate now hides its row, or the admin's restriction rules the
    // old value out. The value itself needn't be one the assistant offers:
    // the user had it.
    const reason = settingRefusal(key) ?? restrictionRefusal(entry, old);
    if (reason) { refused[key] = reason; continue; }
    if (same(currentSettingValue(entry), old) || (await writeAndCheck(entry, old))) restored.push(key);
    else refused[key] = 'stopped';
  }
  return { restored, refused };
}
