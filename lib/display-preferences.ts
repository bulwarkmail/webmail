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
