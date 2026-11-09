import type { SettingsSearchTab } from '@/lib/settings-search';

/**
 * Every settings page id, in no particular order. A `/settings/<tab>` link
 * that names none of these (and no plugin page) falls back to the stored tab.
 */
export const SETTINGS_TAB_IDS: readonly SettingsSearchTab[] = [
  'account', 'general', 'notifications', 'appearance', 'accessibility',
  'message_list', 'reading', 'composing', 'vacation', 'filters', 'organize',
  'security', 'sharing', 'recovery', 'calendar', 'contacts', 'files',
  'files_sync', 'addons', 'offline', 'privacy', 'backup', 'desktop',
  'troubleshooting', 'about',
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
  debug: 'troubleshooting',
};

/**
 * Sections that moved to another page, by `<old page>/<section id>`: the page
 * and section that hold them now. A link to `/settings/general/app-lock` or
 * `/settings/backup/offline` still lands on the section. The pre-paint boot
 * script uses it too, to mark the skeleton's row of the page that opens.
 */
export const MOVED_SECTIONS: Record<string, { tab: SettingsSearchTab; section: string }> = {
  // Offline got a page of its own; images, receipts and sender pictures went to Privacy (2026-11).
  'backup/offline': { tab: 'offline', section: 'offline' },
  'reading/images': { tab: 'privacy', section: 'images' },
  'composing/receipts': { tab: 'privacy', section: 'receipts' },
  'message_list/senders': { tab: 'privacy', section: 'senders' },
  // Settings reorg 2026-11-05: General kept language, links and the tour.
  'general/app-lock': { tab: 'privacy', section: 'app-lock' },
  'general/desktop-keystore': { tab: 'privacy', section: 'desktop-keystore' },
  'general/desktop-app': { tab: 'desktop', section: 'desktop-app' },
  'general/desktop-windows': { tab: 'desktop', section: 'desktop-windows' },
  'general/desktop-updates': { tab: 'about', section: 'desktop-updates' },
  'general/desktop-troubleshooting': { tab: 'troubleshooting', section: 'debug' },
  'backup/fix': { tab: 'troubleshooting', section: 'fix' },
  'backup/debug': { tab: 'troubleshooting', section: 'debug' },
};
