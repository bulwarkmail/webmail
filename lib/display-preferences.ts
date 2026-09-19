import type { SettingsState } from '@/stores/settings-store';

// Only presentation. Never share mailbox IDs, identities, trust, or notification settings.
export const DISPLAY_SETTING_KEYS = [
  'fontSize', 'density', 'animationsEnabled', 'messageListOrder', 'messageListOrderScope',
  'dateFormat', 'dateLocale', 'timeFormat', 'showPreview', 'mailLayout', 'emailsPerPage',
  'messageSpacing', 'plainTextFont', 'attachmentPosition', 'emailAlwaysLightMode',
  'hoverActions', 'hoverActionsMode', 'hoverActionsCorner', 'toolbarPosition', 'showToolbarLabels',
  'hideAccountSwitcher', 'showRailAccountList', 'disableThreading', 'senderFavicons',
  'showAvatarsInJunk', 'colorfulSidebarIcons', 'tintListRowsByTag', 'tintListRowsByAccount',
  'showFolderTotalCount', 'hideInlineImageAttachments', 'attachmentImagePreviewsEnabled',
  'enableUnifiedMailbox', 'includeGroupInUnified', 'unifiedCrossAccount',
  'enableCrossUnreadView', 'enableCrossStarredView', 'enableCrossAllView', 'faviconUnreadBadge',
] as const;
export type DisplaySettings = Pick<SettingsState, typeof DISPLAY_SETTING_KEYS[number]>;
export type AccountTheme = { theme: 'light' | 'dark' | 'system'; activeThemeId: string | null };

export function pickDisplaySettings(settings: DisplaySettings): DisplaySettings {
  return Object.fromEntries(DISPLAY_SETTING_KEYS.map(key => [key, settings[key]])) as DisplaySettings;
}

export function isDisplaySetting(key: string): key is keyof DisplaySettings {
  return (DISPLAY_SETTING_KEYS as readonly string[]).includes(key);
}

/**
 * Sanitize display settings arriving from an archive.
 *
 * Runs on the server too (the vault route validates envelopes), so it cannot
 * reach for the settings store to compare against the real defaults. Structural
 * validation is enough: unknown keys are dropped, and whatever survives is
 * merged over the defaults by the store, which owns the actual semantics.
 */
export function parseDisplaySettings(value: unknown): Partial<DisplaySettings> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of DISPLAY_SETTING_KEYS) {
    const v = source[key];
    if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
      || (typeof v === 'string' && v.length <= 64)) out[key] = v;
  }
  return Object.keys(out).length ? out as Partial<DisplaySettings> : undefined;
}

/** A per-account theme choice as stored in the settings store. */
export function parseAccountTheme(value: unknown): AccountTheme | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Partial<AccountTheme>;
  if (v.theme !== 'light' && v.theme !== 'dark' && v.theme !== 'system') return undefined;
  if (v.activeThemeId !== null && (typeof v.activeThemeId !== 'string' || v.activeThemeId.length > 128)) return undefined;
  return { theme: v.theme, activeThemeId: v.activeThemeId ?? null };
}
