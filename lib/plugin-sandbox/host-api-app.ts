// What a plugin may learn about the app itself: where a setting is (the same
// index the settings page searches, in the user's language) and the user's
// preferences. Used by the AI assistant to answer "how do I ...?" and "why
// does the app ...?" with the app's own names and the user's own values.

import { loadEnglishMessages } from '@/i18n/english-catalog';
import { LOCALE_LOADERS } from '@/components/providers/intl-provider';
import { detectBrowserLocale } from '@/i18n/detect-locale';
import { useLocaleStore } from '@/stores/locale-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useThemeStore } from '@/stores/theme-store';
import { useCalendarStore } from '@/stores/calendar-store';
import { useAuthStore } from '@/stores/auth-store';
import { usePolicyStore } from '@/stores/policy-store';
import { fetchConfig, type ConfigData } from '@/hooks/use-config';
import { productName } from '@/lib/product-name';
import { IS_LITE } from '@/lib/lite';
import { isDesktopApp } from '@/lib/desktop/bridge';
import {
  getByPath, settingsSubResults, settingsTabLabelKey, tabKeywords, tabSearchEntries, type SettingsSearchTab,
} from '@/lib/settings-search';
import { currentSessionLimits } from '@/lib/session-policy/limits';
import type { AppSettingsView, SettingsSearchResult } from '../plugin-types';

type Messages = Record<string, unknown>;

const MAX_QUERY = 200;
const MAX_RESULTS = 20;

/** The locale's catalog, English under it (the loaders merge it); English for an unknown one. */
export async function messagesFor(locale: string): Promise<Messages> {
  const loader = LOCALE_LOADERS[locale];
  if (locale === 'en' || !loader) return loadEnglishMessages();
  try {
    return await loader();
  } catch {
    return loadEnglishMessages();
  }
}

/** The settings pages this user has: the server's support and the admin's gates, as on the settings page. */
function availablePages(config: ConfigData | null): Set<SettingsSearchTab> {
  const client = useAuthStore.getState().client;
  const policy = usePolicyStore.getState();
  const gate = (feature: Parameters<typeof policy.isFeatureEnabled>[0]) => {
    try { return policy.isFeatureEnabled(feature); } catch { return true; }
  };
  const stalwart = config?.stalwartFeaturesEnabled ?? true;
  const pages = new Set<SettingsSearchTab>(['account', 'privacy', 'notifications', 'general', 'appearance', 'message_list', 'reading', 'composing', 'organize', 'backup', 'troubleshooting', 'about']);
  if (isDesktopApp()) pages.add('desktop');
  if (!IS_LITE) pages.add('offline');
  if (stalwart) pages.add('security');
  if (client?.supportsSieve?.()) pages.add('filters');
  if (client?.supportsVacationResponse?.()) pages.add('vacation');
  if (client?.supportsCalendars?.() && gate('calendarEnabled')) pages.add('calendar');
  if (gate('contactsEnabled')) pages.add('contacts');
  if (client?.supportsFiles?.() && gate('filesEnabled')) pages.add('files');
  if (gate('sidebarAppsEnabled') || gate('pluginsEnabled')) pages.add('addons');
  return pages;
}

function pageName(messages: Messages, tab: SettingsSearchTab): string {
  const name = getByPath(messages, settingsTabLabelKey(tab, isDesktopApp()));
  return typeof name === 'string' ? name : tab;
}

/**
 * Settings matching a query, in the user's language: the page, the
 * setting's label and its description. The query may be in the user's
 * language or in English (a model often asks in English); every word counts.
 */
export async function doAppSearchSettings(query: unknown, options?: unknown): Promise<SettingsSearchResult[]> {
  if (typeof query !== 'string' || !query.trim()) throw new Error('app.searchSettings: query must be a non-empty string');
  const words = query.toLowerCase().slice(0, MAX_QUERY).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!words.length) return [];
  const rawLimit = (options as { limit?: unknown } | undefined)?.limit;
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? Math.min(MAX_RESULTS, Math.max(1, Math.floor(rawLimit))) : 8;

  const locale = useLocaleStore.getState().locale || detectBrowserLocale('en');
  const local = await messagesFor(locale);
  const english = await loadEnglishMessages();
  // One config read for both: an unreachable /api/config keeps the defaults.
  const config = await fetchConfig().catch(() => null);
  const pages = availablePages(config);
  const appName = productName(config?.appName);

  const scored: { score: number; order: number; result: SettingsSearchResult }[] = [];
  let order = 0;
  for (const tab of Object.keys(tabSearchEntries) as SettingsSearchTab[]) {
    if (!pages.has(tab)) continue;
    const page = pageName(local, tab);
    const pageHaystack = `${page} ${pageName(english, tab)} ${tab.replace(/_/g, ' ')} ${tabKeywords[tab] ?? ''}`.toLowerCase();
    // The merged catalogue has the English one's shape, so both lists line up.
    const mine = settingsSubResults(local, tab, appName);
    const theirs = settingsSubResults(english, tab, appName);
    mine.forEach((entry, i) => {
      const en = theirs[i];
      const text = `${entry.label} ${entry.description ?? ''} ${entry.keywords ?? ''} ${en?.label ?? ''} ${en?.description ?? ''} ${en?.keywords ?? ''}`.toLowerCase();
      let score = 0;
      for (const word of words) {
        if (text.includes(word)) score += 2;
        else if (pageHaystack.includes(word)) score += 1;
      }
      if (score > 0) {
        scored.push({ score, order: order++, result: { pageId: tab, page, label: entry.label, ...(entry.description ? { description: entry.description } : {}) } });
      }
    });
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const seen = new Set<string>();
  const out: SettingsSearchResult[] = [];
  for (const { result } of scored) {
    const key = `${result.pageId}|${result.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(result);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * The user's preferences that say how the app behaves for them: layout,
 * theme, language and formats, reading and sending behaviour, notifications.
 * Plain values only; nothing about other people (trusted senders, mutes)
 * and nothing that addresses a server (the push relay).
 */
export const SHARED_SETTINGS = [
  'fontSize', 'density', 'interfaceLayout', 'mailLayout', 'toolbarPosition', 'showToolbarLabels', 'reduceMotion', 'proInterface',
  'contrast', 'underlineLinks', 'appFont', 'focusRing', 'largeTargets', 'singleKeyShortcuts', 'toastDuration',
  'dateFormat', 'timeFormat', 'firstDayOfWeek', 'timeZone',
  'disableThreading', 'showPreview', 'listColumns', 'emailsPerPage', 'showVerificationCodes',
  'markAsReadDelay', 'externalContentPolicy', 'mailAttachmentAction', 'emailAlwaysLightMode', 'returnToListAfterAction', 'plainTextFont',
  'deleteAction', 'archiveMode', 'permanentlyDeleteJunk', 'confirmBulkDelete',
  'sendDelaySeconds', 'sendConfirmation', 'defaultReplyMode', 'plainTextMode', 'signaturePosition', 'signatureSeparatorEnabled',
  'signatureNewMailEnabled', 'signatureReplyForwardEnabled',
  'requestReadReceiptDefault', 'readReceiptResponse', 'autoSelectReplyIdentity',
  'showWeekNumbers', 'calendarWorkingDays', 'enableCalendarTasks', 'showBirthdayCalendar',
  'emailNotificationsEnabled', 'emailNotificationSound', 'calendarNotificationsEnabled',
  'enableUnifiedMailbox', 'sessionTimeout',
  // Everything else app.setSettings may change (lib/settings-schema.ts), so
  // a plugin reads the current value before it proposes a new one.
  'colorfulSidebarIcons', 'showFolderTotalCount', 'hideAccountSwitcher', 'sidebarAccountSwitcher', 'showRailAccountList',
  'unifiedCrossAccount', 'includeGroupInUnified', 'enableCrossUnreadView', 'enableCrossStarredView', 'enableCrossAllView',
  'tintListRowsByAccount', 'showAccountDot', 'showSharedMailAccounts', 'compactSharedMailboxes', 'showAdvancedSettings',
  'dateLocale', 'protocolOpenMode', 'showOnboardingOnNewDevices',
  'mvInboxType', 'messageListOrderScope', 'tintListRowsByTag', 'senderFavicons', 'showAvatarsInJunk',
  'hoverActions', 'hoverActionsMode', 'hoverActionsCorner', 'swipeRightAction', 'swipeLeftAction',
  'searchDefaultScope', 'clearSearchOnFolderChange',
  'messageSpacing', 'attachmentImagePreviewsEnabled', 'hideInlineImageAttachments',
  'filenameSpaceReplacement', 'filenameLowercase', 'filenameStripDiacritics', 'filenameCollapseSeparators', 'postExportAction',
  'recipientMentionsEnabled', 'mentionAddsRecipientTo', 'rtlEditingSupport', 'quickReplyEnabled', 'replyUnderMessage', 'replyIdentityMatch',
  'attachmentReminderEnabled', 'attachmentReminderKeywords', 'emptySubjectWarningEnabled', 'placeholderWarningEnabled',
  'notificationSoundChoice', 'pushNotifyInboxOnly', 'faviconUnreadBadge', 'unreadBadgeAllAccounts', 'calendarNotificationSound', 'doNotDisturb', 'visualAlerts',
  'calendarInvitationParsingEnabled', 'showTimeInMonthView', 'calendarTintedEvents', 'calendarMonthTimedEvents',
  'calendarLimitHours', 'calendarDayStartHour', 'calendarDayEndHour', 'calendarHideNonWorkingDays',
  'calendarFreeScroll', 'calendarHoverPreview', 'showTasksOnCalendar',
  'groupContactsByLetter', 'sortContactsByLastName', 'showContactsDirectory',
  'showAccessibilityButton', 'lineSpacing', 'letterSpacing', 'wordSpacing', 'paragraphSpacing', 'readingWidth',
  'readingMask', 'reduceTransparency', 'showColorNames', 'colorBlindPalette', 'pauseAnimatedImages',
  'focusAlwaysVisible', 'largeCursor', 'openOnHover', 'showRowActionButton', 'nativeScrollbars',
  'mailViewMode', 'mailTextScale', 'mailMinFontSize', 'mailOverrideStyles', 'mailFitWidth', 'readAloudRate',
  'composeFontFamily', 'composeFontSize', 'confirmDelete', 'confirmArchive', 'unreadCountStyle',
  'announceNewMail', 'announceRowPreview', 'simpleMode', 'simpleModePagedList',
] as const;

/** Lists longer than this are cut; the reminder words (29 by default) must come through whole. */
const MAX_LIST_ITEMS = 50;

export function doAppGetSettings(): AppSettingsView {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const out: AppSettingsView = {};
  for (const key of SHARED_SETTINGS) {
    const value = state[key];
    if (typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'number' || typeof v === 'string')) out[key] = value.slice(0, MAX_LIST_ITEMS) as number[] | string[];
  }
  // Plugins written before Reduce motion (v9) read this switch.
  out.animationsEnabled = state.reduceMotion !== 'on';
  // Minutes without activity before Bulwark signs out (0 = never). The user
  // setting of that name was never read; the organisation's idle timeout is
  // what applies, the strictest of the accounts signed in here.
  const limits = currentSessionLimits();
  out.sessionTimeout = limits
    ? limits.idle?.minutes ?? 0
    : usePolicyStore.getState().getOrganisation().session.idleMinutes;
  const theme = (useThemeStore.getState() as unknown as { theme?: unknown }).theme;
  if (typeof theme === 'string') out.theme = theme;
  const locale = useLocaleStore.getState().locale;
  if (locale) out.language = locale;
  // Settings > Calendar > Default view (the calendar store's viewMode).
  const calendarView = useCalendarStore.getState().viewMode;
  if (typeof calendarView === 'string') out.calendarView = calendarView;
  return out;
}
