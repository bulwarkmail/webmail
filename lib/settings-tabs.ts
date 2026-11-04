import type { SettingsSearchTab } from '@/lib/settings-search';

/**
 * Every settings page id, in no particular order. A `/settings/<tab>` link
 * that names none of these (and no plugin page) falls back to the stored tab.
 */
export const SETTINGS_TAB_IDS: readonly SettingsSearchTab[] = [
  'account', 'general', 'notifications', 'appearance', 'accessibility',
  'message_list', 'reading', 'composing', 'vacation', 'filters', 'organize',
  'security', 'sharing', 'recovery', 'calendar', 'contacts', 'files',
  'addons', 'offline', 'privacy', 'backup', 'about',
];

// Map legacy tab IDs to current ones; runs once on read of localStorage and
// for every deep link, so old bookmarks, connector links and sidebar gears
// land on the page that now holds the setting. The pre-paint boot script
// uses it too, to pick the settings skeleton's active row.
export const LEGACY_TAB_MAP: Record<string, SettingsSearchTab> = {
  email: 'reading',
  advanced: 'backup',
  layout: 'appearance',
  themes: 'appearance',
  content_senders: 'privacy',
  identities: 'account',
  language: 'general',
  protocol_handlers: 'general',
  templates: 'composing',
  folders: 'organize',
  keywords: 'organize',
  downloads: 'reading',
  sidebar_apps: 'addons',
  plugins: 'addons',
  about_data: 'backup',
  debug: 'backup',
};
