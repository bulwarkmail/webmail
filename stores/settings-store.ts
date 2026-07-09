import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useThemeStore } from './theme-store';
import { useLocaleStore } from './locale-store';
import type { NotificationSoundChoice } from '@/lib/notification-sound';
import { apiFetch } from '@/lib/browser-navigation';
import {
  DEFAULT_SUB_ADDRESS_DELIMITER,
  isValidSubAddressDelimiter,
} from '@/lib/sub-addressing';

// Use console directly to avoid circular dependency with lib/debug.ts
// (debug.ts imports useSettingsStore for debugMode check)
const syncLog = (...args: unknown[]) => console.log('[SETTINGS_SYNC]', ...args);
const syncWarn = (...args: unknown[]) => console.warn('[SETTINGS_SYNC]', ...args);
const syncError = (...args: unknown[]) => console.error('[SETTINGS_SYNC]', ...args);

/** True for a non-null, non-array plain object (the allMailFolderIds map shape). */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Settings sync state (module-level, not persisted)
let syncEnabled = false;
let syncUsername: string | null = null;
let syncServerUrl: string | null = null;
let syncTimeout: ReturnType<typeof setTimeout> | null = null;
let isLoadingFromServer = false;

const SYNC_DEBOUNCE_MS = 2000;

export type FontSize = 'small' | 'medium' | 'large';
export type Density = 'extra-compact' | 'compact' | 'regular' | 'comfortable';
/** @deprecated Use Density instead */
export type ListDensity = Density;
export type DeleteAction = 'trash' | 'trash-and-read' | 'permanent';
export type ReplyMode = 'reply' | 'replyAll';
export type SignaturePosition = 'above_quote' | 'below_quote';
/** How to handle an incoming Disposition-Notification-To (read-receipt) request. */
export type ReadReceiptResponse = 'ask' | 'always' | 'never';
export type DateFormat = 'smart' | 'relative' | 'full';
/**
 * Regional ordering of numeric dates, independent of the `DateFormat` style.
 *   - `auto`  — follow the UI language (today's behaviour).
 *   - `iso`   — ISO 8601, `YYYY-MM-DD`.
 *   - `en-GB` — Day/Month/Year (`DD/MM/YYYY`).
 *   - `en-US` — Month/Day/Year (`MM/DD/YYYY`).
 */
export type DateLocale = 'auto' | 'iso' | 'en-GB' | 'en-US';
export type TimeFormat = '12h' | '24h';
export type FirstDayOfWeek = 0 | 1 | 6; // 0 = Sunday, 1 = Monday, 6 = Saturday
export type ExternalContentPolicy = 'ask' | 'block' | 'allow';
export type MailAttachmentAction = 'preview' | 'download';
export type AttachmentPosition = 'beside-sender' | 'below-header';
export type ToolbarPosition = 'top' | 'below-subject';
export type ArchiveMode = 'single' | 'year' | 'month';
export type MailLayout = 'split' | 'focus' | 'horizontal';
export type CalendarHoverPreview = 'off' | 'instant' | 'delay-500ms' | 'delay-1s' | 'delay-2s';
export type SendDelaySeconds = 0 | 10 | 30 | 60;
export type ProtocolOpenMode = 'active-session' | 'new-tab';

/**
 * Settings that must never round-trip through the cross-device sync API.
 * Decided per device and kept only in the local zustand-persist storage -
 * a value already stored on the server (from a prior build) is ignored on
 * import.
 */
const DEVICE_LOCAL_SETTING_KEYS = new Set<string>(['proInterface']);

export type HoverAction = 'delete' | 'star' | 'markRead' | 'archive' | 'tag' | 'spam';
export type HoverActionsMode = 'inline' | 'floating';
export type HoverActionsCorner = 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left';

export const ALL_HOVER_ACTIONS: { id: HoverAction; labelKey: string }[] = [
  { id: 'delete', labelKey: 'delete' },
  { id: 'star', labelKey: 'star' },
  { id: 'markRead', labelKey: 'mark_read' },
  { id: 'archive', labelKey: 'archive' },
  { id: 'tag', labelKey: 'tag' },
  { id: 'spam', labelKey: 'spam' },
];

export type DebugCategory = 'jmap' | 'calendar' | 'tasks' | 'auth' | 'filters' | 'email' | 'push' | 'contacts';

export const ALL_DEBUG_CATEGORIES: { id: DebugCategory; labelKey: string }[] = [
  { id: 'jmap', labelKey: 'jmap' },
  { id: 'calendar', labelKey: 'calendar' },
  { id: 'tasks', labelKey: 'tasks' },
  { id: 'auth', labelKey: 'auth' },
  { id: 'filters', labelKey: 'filters' },
  { id: 'email', labelKey: 'email' },
  { id: 'push', labelKey: 'push' },
  { id: 'contacts', labelKey: 'contacts' },
];

export interface KeywordDefinition {
  id: string;     // Used as JMAP keyword suffix: $label:<id>
  label: string;  // Display name
  color: string;  // Key from KEYWORD_PALETTE
}

export interface SidebarApp {
  id: string;
  name: string;
  url: string;
  icon: string;       // Lucide icon name (e.g. 'Globe', 'Rss')
  openMode: 'tab' | 'inline'; // Open in new tab or embed inline
  showOnMobile: boolean;
}

// Available color palette for keywords
export const KEYWORD_PALETTE: Record<string, { dot: string; bg: string }> = {
  red: { dot: 'bg-red-500', bg: 'bg-red-50 dark:bg-red-950/30' },
  orange: { dot: 'bg-orange-500', bg: 'bg-orange-50 dark:bg-orange-950/30' },
  yellow: { dot: 'bg-yellow-500', bg: 'bg-yellow-50 dark:bg-yellow-950/30' },
  green: { dot: 'bg-green-500', bg: 'bg-green-50 dark:bg-green-950/30' },
  blue: { dot: 'bg-blue-500', bg: 'bg-blue-50 dark:bg-blue-950/30' },
  purple: { dot: 'bg-purple-500', bg: 'bg-purple-50 dark:bg-purple-950/30' },
  pink: { dot: 'bg-pink-500', bg: 'bg-pink-50 dark:bg-pink-950/30' },
  teal: { dot: 'bg-teal-500', bg: 'bg-teal-50 dark:bg-teal-950/30' },
  cyan: { dot: 'bg-cyan-500', bg: 'bg-cyan-50 dark:bg-cyan-950/30' },
  indigo: { dot: 'bg-indigo-500', bg: 'bg-indigo-50 dark:bg-indigo-950/30' },
  amber: { dot: 'bg-amber-500', bg: 'bg-amber-50 dark:bg-amber-950/30' },
  lime: { dot: 'bg-lime-500', bg: 'bg-lime-50 dark:bg-lime-950/30' },
  gray: { dot: 'bg-gray-500', bg: 'bg-gray-50 dark:bg-gray-950/30' },
} as const;

export const DEFAULT_KEYWORDS: KeywordDefinition[] = [
  { id: 'red', label: 'Red', color: 'red' },
  { id: 'orange', label: 'Orange', color: 'orange' },
  { id: 'yellow', label: 'Yellow', color: 'yellow' },
  { id: 'green', label: 'Green', color: 'green' },
  { id: 'blue', label: 'Blue', color: 'blue' },
  { id: 'purple', label: 'Purple', color: 'purple' },
  { id: 'pink', label: 'Pink', color: 'pink' },
];

interface SettingsState {
  // Appearance
  fontSize: FontSize;
  density: Density;
  animationsEnabled: boolean;

  // Language & Region
  dateFormat: DateFormat;
  dateLocale: DateLocale;
  timeFormat: TimeFormat;
  firstDayOfWeek: FirstDayOfWeek;

  // Email Behavior
  markAsReadDelay: number; // milliseconds (0 = instant, -1 = never)
  deleteAction: DeleteAction;
  permanentlyDeleteJunk: boolean; // Permanently delete emails from junk/spam instead of moving to trash
  returnToListAfterAction: boolean; // After delete / mark-unread in an open message, return to the list instead of opening the next message
  showPreview: boolean;
  mailLayout: MailLayout;
  emailsPerPage: number;
  externalContentPolicy: ExternalContentPolicy;
  mailAttachmentAction: MailAttachmentAction;
  attachmentPosition: AttachmentPosition;
  emailAlwaysLightMode: boolean; // Always render email content in light mode
  archiveMode: ArchiveMode; // How to organize archived emails: single folder, by year, or by year+month
  hoverActions: HoverAction[]; // Quick actions shown on hover in mail list
  hoverActionsMode: HoverActionsMode; // Display mode: inline (current) or floating corner
  hoverActionsCorner: HoverActionsCorner; // Corner for floating mode

  // Composer
  autoSaveDraftInterval: number; // milliseconds
  sendConfirmation: boolean;
  defaultReplyMode: ReplyMode;
  autoSelectReplyIdentity: boolean;
  plainTextMode: boolean; // Send plain text only (no rich text editor)
  rtlEditingSupport: boolean; // Show a per-paragraph LTR/RTL direction control in the composer (Gmail-style)
  subAddressDelimiter: string; // Character separating user from tag (e.g. "user+tag@")
  sendDelaySeconds: SendDelaySeconds;
  signaturePosition: SignaturePosition; // Position of the signature relative to quoted text in replies/forwards
  signatureSeparatorEnabled: boolean; // Prefix the signature with the RFC 3676 "-- " delimiter
  requestReadReceiptDefault: boolean; // Pre-check "request read receipt" in the composer
  readReceiptResponse: ReadReceiptResponse; // How to respond to incoming read-receipt requests

  // Identities
  // Per-account default ("preferred primary") sender identity, keyed by
  // username (the same key settings sync uses). A JMAP identity id is only
  // meaningful within its own account, so this must be account-scoped. Synced
  // so the choice survives a new browser / cleared site data (#507).
  preferredIdentityIds: Record<string, string | null>;

  // Privacy & Security
  sessionTimeout: number; // minutes (0 = never)
  trustedSenders: string[]; // Email addresses that can load external content
  // Store trusted senders in a dedicated JMAP address book so they sync across
  // devices. `null` means "not yet decided": resolved on first connect to
  // `true` when the server supports contacts, otherwise left off. Once the user
  // toggles it, it holds a concrete boolean and is never auto-changed again.
  trustedSendersAddressBook: boolean | null;

  // Filters
  expandedFilterView: boolean;

  // Calendar
  showTimeInMonthView: boolean;
  showWeekNumbers: boolean;
  calendarHoverPreview: CalendarHoverPreview;

  // Calendar Tasks
  enableCalendarTasks: boolean;
  showTasksOnCalendar: boolean;

  // Contact Birthday Calendar
  showBirthdayCalendar: boolean;
  birthdayCalendarColor: string;

  // Per-viewer color overrides for shared calendars, keyed by
  // sharedCalendarColorKey(). Lets each recipient recolor calendars shared
  // with them without changing the owner's color (see #345).
  sharedCalendarColors: Record<string, string>;

  // Contacts Display
  groupContactsByLetter: boolean;

  // Email Notifications
  emailNotificationsEnabled: boolean;
  emailNotificationSound: boolean;
  notificationSoundChoice: NotificationSoundChoice;

  // Protocol Handlers
  protocolOpenMode: ProtocolOpenMode;

  // Calendar Notifications
  calendarNotificationsEnabled: boolean;
  calendarNotificationSound: boolean;
  calendarInvitationParsingEnabled: boolean;

  // Layout
  toolbarPosition: ToolbarPosition;
  showToolbarLabels: boolean;
  hideAccountSwitcher: boolean;
  showRailAccountList: boolean;
  proInterface: boolean;

  // Unified Mailbox
  enableUnifiedMailbox: boolean;
  includeGroupInUnified: boolean;

  // All Mail view (gated): user toggle (like the unified mailbox) plus the set
  // of folder ids merged into the virtual "All Mail" mailbox. `null` = never
  // configured, in which case the view defaults to all non-special (no-role)
  // folders of the active account.
  enableAllMailView: boolean;

  // Cross-account "All accounts" views (gated per-view by the admin policy)
  enableCrossUnreadView: boolean;
  enableCrossStarredView: boolean;
  enableCrossAllView: boolean;

  // Per-account "All Mail" folder selection, keyed by AccountEntry.id. A
  // missing entry = "not configured" -> defaults to every no-role folder; an
  // explicit [] = "no folders". (Replaced the legacy global string[] | null.)
  allMailFolderIds: Record<string, string[]>;

  // Email Display
  disableThreading: boolean; // Show emails as individual messages instead of grouped by conversation

  senderFavicons: boolean;
  showAvatarsInJunk: boolean; // Show profile images/favicons in the junk folder

  // Sidebar
  colorfulSidebarIcons: boolean; // Tint folder icons by role (inbox blue, junk red, etc.)
  tintListRowsByTag: boolean; // Tint mail-list rows by the first tag color
  showFolderTotalCount: boolean; // Show total message count next to folders/tags (alongside unread)

  // Folders
  folderIcons: Record<string, string>; // mailboxId -> icon name

  // Keywords (labels/tags)
  emailKeywords: KeywordDefinition[];

  // Attachment Reminder
  attachmentReminderEnabled: boolean;
  attachmentReminderKeywords: string[];

  // Hide inline images (images referenced by cid in the HTML body) from the
  // attachment list shown above the message body.
  hideInlineImageAttachments: boolean;

  // Render image attachments as thumbnail cards (preview the actual image
  // contents inside the chip) instead of generic file icons.
  attachmentImagePreviewsEnabled: boolean;

  // Sidebar Apps
  sidebarApps: SidebarApp[];
  keepAppsLoaded: boolean;

  // Onboarding
  onboardingCompleted: boolean; // Welcome banner dismissed
  tourCompleted: boolean; // Interactive tour completed
  showOnboardingOnNewDevices: boolean; // When true, onboarding shows again on each new device

  // Downloads
  emailDownloadTemplate: string;
  attachmentDownloadTemplate: string;
  bundleDownloadTemplate: string;
  filenameSpaceReplacement: 'keep' | 'underscore' | 'dash';
  filenameLowercase: boolean;
  filenameStripDiacritics: boolean;
  filenameCollapseSeparators: boolean;
  postExportAction: 'keep' | 'archive' | 'trash';

  // Advanced
  debugMode: boolean;
  debugCategories: Record<DebugCategory, boolean>;
  settingsSyncDisabled: boolean;

  // Actions
  updateSetting: <K extends keyof SettingsState>(
    key: K,
    value: SettingsState[K]
  ) => void;
  resetToDefaults: () => void;
  exportSettings: () => string;
  importSettings: (json: string) => boolean;

  // Folder icons
  setFolderIcon: (mailboxId: string, icon: string) => void;
  removeFolderIcon: (mailboxId: string) => void;

  // Shared-calendar color overrides
  setSharedCalendarColor: (key: string, color: string) => void;
  removeSharedCalendarColor: (key: string) => void;

  // Trusted senders
  addTrustedSender: (email: string) => void;
  removeTrustedSender: (email: string) => void;
  isSenderTrusted: (email: string) => boolean;

  // Keywords
  addKeyword: (keyword: KeywordDefinition) => void;
  updateKeyword: (id: string, updates: Partial<Omit<KeywordDefinition, 'id'>>) => void;
  renameKeyword: (oldId: string, newKeyword: KeywordDefinition) => void;
  removeKeyword: (id: string) => void;
  reorderKeywords: (keywords: KeywordDefinition[]) => void;
  getKeywordById: (id: string) => KeywordDefinition | undefined;

  // Sidebar Apps
  addSidebarApp: (app: SidebarApp) => void;
  updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => void;
  removeSidebarApp: (id: string) => void;
  reorderSidebarApps: (apps: SidebarApp[]) => void;

  // Settings sync
  enableSync: (username: string, serverUrl: string) => void;
  disableSync: () => void;
  loadFromServer: (username: string, serverUrl: string) => Promise<boolean>;
}

const DEFAULT_SETTINGS = {
  // Appearance
  fontSize: 'medium' as FontSize,
  density: 'regular' as Density,
  animationsEnabled: true,

  // Language & Region
  dateFormat: 'smart' as DateFormat,
  dateLocale: 'auto' as DateLocale,
  timeFormat: '24h' as TimeFormat,
  firstDayOfWeek: 1 as FirstDayOfWeek, // Monday

  // Email Behavior
  markAsReadDelay: 0, // Instant
  deleteAction: 'trash' as DeleteAction,
  permanentlyDeleteJunk: false,
  returnToListAfterAction: true,
  showPreview: true,
  mailLayout: 'split' as MailLayout,
  emailsPerPage: 50,
  externalContentPolicy: 'ask' as ExternalContentPolicy,
  mailAttachmentAction: 'preview' as MailAttachmentAction,
  attachmentPosition: 'beside-sender' as AttachmentPosition,
  emailAlwaysLightMode: false,
  archiveMode: 'single' as ArchiveMode,
  hoverActions: ['delete', 'star', 'markRead', 'archive'] as HoverAction[],
  hoverActionsMode: 'inline' as HoverActionsMode,
  hoverActionsCorner: 'top-right' as HoverActionsCorner,

  // Composer
  autoSaveDraftInterval: 60000, // 1 minute
  sendConfirmation: false,
  defaultReplyMode: 'reply' as ReplyMode,
  autoSelectReplyIdentity: false,
  plainTextMode: false,
  rtlEditingSupport: false,
  subAddressDelimiter: DEFAULT_SUB_ADDRESS_DELIMITER,
  sendDelaySeconds: 0 as SendDelaySeconds,
  signaturePosition: 'below_quote' as SignaturePosition,
  signatureSeparatorEnabled: true,
  requestReadReceiptDefault: false,
  readReceiptResponse: 'ask' as ReadReceiptResponse,

  // Identities
  preferredIdentityIds: {} as Record<string, string | null>,

  // Privacy & Security
  sessionTimeout: 0, // Never
  trustedSenders: [] as string[],
  trustedSendersAddressBook: null as boolean | null,

  // Filters
  expandedFilterView: false,

  // Calendar
  showTimeInMonthView: false,
  showWeekNumbers: false,
  calendarHoverPreview: 'delay-500ms' as CalendarHoverPreview,

  // Calendar Tasks
  enableCalendarTasks: false,
  showTasksOnCalendar: true,

  // Contact Birthday Calendar
  showBirthdayCalendar: false,
  birthdayCalendarColor: '#eab308',

  sharedCalendarColors: {} as Record<string, string>,

  // Contacts Display
  groupContactsByLetter: true,

  // Email Notifications
  emailNotificationsEnabled: true,
  emailNotificationSound: true,
  notificationSoundChoice: 'default' as NotificationSoundChoice,

  // Protocol Handlers
  protocolOpenMode: 'new-tab' as ProtocolOpenMode,

  // Calendar Notifications
  calendarNotificationsEnabled: true,
  calendarNotificationSound: true,
  calendarInvitationParsingEnabled: true,

  // Layout
  toolbarPosition: 'top' as ToolbarPosition,
  showToolbarLabels: true,
  hideAccountSwitcher: false,
  showRailAccountList: false,
  proInterface: false,

  // Unified Mailbox
  enableUnifiedMailbox: false,
  includeGroupInUnified: false,

  // All Mail view (gated)
  enableAllMailView: false,
  allMailFolderIds: {} as Record<string, string[]>,

  enableCrossUnreadView: false,
  enableCrossStarredView: false,
  enableCrossAllView: false,

  // Email Display
  disableThreading: false,

  senderFavicons: true,
  showAvatarsInJunk: false,

  // Sidebar
  colorfulSidebarIcons: true,
  tintListRowsByTag: true,
  showFolderTotalCount: true,

  // Folders
  folderIcons: {} as Record<string, string>,

  // Keywords
  emailKeywords: DEFAULT_KEYWORDS,

  // Attachment Reminder
  attachmentReminderEnabled: true,
  attachmentReminderKeywords: [
    // English
    'attached', 'attachment', 'attachments', 'see attached', 'find attached', 'please find attached',
    // German
    'angehängt', 'anhang', 'anbei', 'im anhang',
    // French
    'ci-joint', 'pièce jointe',
    // Spanish
    'adjunto', 'adjunta', 'en adjunto',
    // Italian
    'allegato', 'in allegato',
    // Dutch
    'bijgevoegd', 'bijlage',
    // Portuguese
    'em anexo', 'anexo',
    // Polish
    'w załączniku',
    // Russian
    'во вложении',
    // Japanese
    '添付',
    // Chinese
    '附件',
    // Korean
    '첨부',
    // Latvian
    'pielikumā',
  ] as string[],

  hideInlineImageAttachments: true,
  attachmentImagePreviewsEnabled: true,

  // Sidebar Apps
  sidebarApps: [] as SidebarApp[],
  keepAppsLoaded: false,

  // Onboarding
  onboardingCompleted: false,
  tourCompleted: false,
  showOnboardingOnNewDevices: false,

  // Downloads
  emailDownloadTemplate: '{date} ({from}-{to}) {subject}',
  attachmentDownloadTemplate: '{filename}',
  bundleDownloadTemplate: 'emails-{count}',
  filenameSpaceReplacement: 'keep' as 'keep' | 'underscore' | 'dash',
  filenameLowercase: false,
  filenameStripDiacritics: false,
  filenameCollapseSeparators: true,
  postExportAction: 'keep' as 'keep' | 'archive' | 'trash',

  // Advanced
  debugMode: false,
  debugCategories: {
    jmap: true,
    calendar: true,
    tasks: true,
    auth: true,
    filters: true,
    email: true,
    push: true,
  } as Record<DebugCategory, boolean>,
  settingsSyncDisabled: false,
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,

      updateSetting: (key, value) => {
        set({ [key]: value });

        // Apply font size to document root
        if (key === 'fontSize') {
          applyFontSize(value as FontSize);
        }

        // Apply density to document root
        if (key === 'density') {
          applyDensity(value as Density);
        }

        // Apply animations to document root
        if (key === 'animationsEnabled') {
          applyAnimations(value as boolean);
        }
      },

      resetToDefaults: () => {
        set(DEFAULT_SETTINGS);
        applyFontSize(DEFAULT_SETTINGS.fontSize);
        applyDensity(DEFAULT_SETTINGS.density);
        applyAnimations(DEFAULT_SETTINGS.animationsEnabled);
      },

      exportSettings: () => {
        const state = get();
        const settings = {
          fontSize: state.fontSize,
          density: state.density,
          animationsEnabled: state.animationsEnabled,
          dateFormat: state.dateFormat,
          dateLocale: state.dateLocale,
          timeFormat: state.timeFormat,
          firstDayOfWeek: state.firstDayOfWeek,
          markAsReadDelay: state.markAsReadDelay,
          deleteAction: state.deleteAction,
          returnToListAfterAction: state.returnToListAfterAction,
          showPreview: state.showPreview,
          mailLayout: state.mailLayout,
          emailsPerPage: state.emailsPerPage,
          externalContentPolicy: state.externalContentPolicy,
          mailAttachmentAction: state.mailAttachmentAction,
          attachmentPosition: state.attachmentPosition,
          archiveMode: state.archiveMode,
          hoverActions: state.hoverActions,
          hoverActionsMode: state.hoverActionsMode,
          hoverActionsCorner: state.hoverActionsCorner,
          disableThreading: state.disableThreading,
          trustedSenders: state.trustedSenders,
          autoSaveDraftInterval: state.autoSaveDraftInterval,
          sendConfirmation: state.sendConfirmation,
          defaultReplyMode: state.defaultReplyMode,
          autoSelectReplyIdentity: state.autoSelectReplyIdentity,
          plainTextMode: state.plainTextMode,
          rtlEditingSupport: state.rtlEditingSupport,
          subAddressDelimiter: state.subAddressDelimiter,
          sendDelaySeconds: state.sendDelaySeconds,
          signaturePosition: state.signaturePosition,
          signatureSeparatorEnabled: state.signatureSeparatorEnabled,
          requestReadReceiptDefault: state.requestReadReceiptDefault,
          readReceiptResponse: state.readReceiptResponse,
          preferredIdentityIds: state.preferredIdentityIds,
          sessionTimeout: state.sessionTimeout,
          emailNotificationsEnabled: state.emailNotificationsEnabled,
          emailNotificationSound: state.emailNotificationSound,
          notificationSoundChoice: state.notificationSoundChoice,
          protocolOpenMode: state.protocolOpenMode,
          calendarNotificationsEnabled: state.calendarNotificationsEnabled,
          calendarNotificationSound: state.calendarNotificationSound,
          calendarInvitationParsingEnabled: state.calendarInvitationParsingEnabled,
          enableCalendarTasks: state.enableCalendarTasks,
          showTasksOnCalendar: state.showTasksOnCalendar,
          showBirthdayCalendar: state.showBirthdayCalendar,
          birthdayCalendarColor: state.birthdayCalendarColor,
          sharedCalendarColors: state.sharedCalendarColors,
          groupContactsByLetter: state.groupContactsByLetter,
          expandedFilterView: state.expandedFilterView,
          showTimeInMonthView: state.showTimeInMonthView,
          showWeekNumbers: state.showWeekNumbers,
          calendarHoverPreview: state.calendarHoverPreview,
          toolbarPosition: state.toolbarPosition,
          hideAccountSwitcher: state.hideAccountSwitcher,
          showRailAccountList: state.showRailAccountList,
          // proInterface is intentionally omitted - it's a per-device choice
          // (see DEVICE_LOCAL_SETTING_KEYS) and must not be synced.
          enableUnifiedMailbox: state.enableUnifiedMailbox,
          includeGroupInUnified: state.includeGroupInUnified,
          enableAllMailView: state.enableAllMailView,
          allMailFolderIds: state.allMailFolderIds,
          enableCrossUnreadView: state.enableCrossUnreadView,
          enableCrossStarredView: state.enableCrossStarredView,
          enableCrossAllView: state.enableCrossAllView,
          senderFavicons: state.senderFavicons,
          showAvatarsInJunk: state.showAvatarsInJunk,
          colorfulSidebarIcons: state.colorfulSidebarIcons,
          tintListRowsByTag: state.tintListRowsByTag,
          showFolderTotalCount: state.showFolderTotalCount,
          folderIcons: state.folderIcons,
          emailKeywords: state.emailKeywords,
          attachmentReminderEnabled: state.attachmentReminderEnabled,
          attachmentReminderKeywords: state.attachmentReminderKeywords,
          hideInlineImageAttachments: state.hideInlineImageAttachments,
          attachmentImagePreviewsEnabled: state.attachmentImagePreviewsEnabled,
          sidebarApps: state.sidebarApps,
          keepAppsLoaded: state.keepAppsLoaded,
          onboardingCompleted: state.onboardingCompleted,
          tourCompleted: state.tourCompleted,
          showOnboardingOnNewDevices: state.showOnboardingOnNewDevices,
          debugMode: state.debugMode,
          debugCategories: state.debugCategories,
          settingsSyncDisabled: state.settingsSyncDisabled,
          // Cross-store settings
          theme: useThemeStore.getState().theme,
          locale: useLocaleStore.getState().locale,
        };
        return JSON.stringify(settings, null, 2);
      },

      importSettings: (json: string) => {
        try {
          const settings = JSON.parse(json);

          // Validate settings
          if (typeof settings !== 'object' || settings === null) {
            return false;
          }

          if (typeof settings.protocolOpenMode !== 'string' && typeof settings.protocolMailtoOpenMode === 'string') {
            settings.protocolOpenMode = settings.protocolMailtoOpenMode;
          }

          // Apply settings
          Object.keys(settings).forEach((key) => {
            if (key in DEFAULT_SETTINGS) {
              if (key === 'subAddressDelimiter' && !isValidSubAddressDelimiter(settings[key])) {
                return;
              }
              if (key === 'sendDelaySeconds' && ![0, 10, 30, 60].includes(settings[key])) {
                set({ sendDelaySeconds: 0 });
                return;
              }
              // Ignore a legacy global allMailFolderIds (string[] | null) or any
              // non-record value - this build keys it per account.
              if (key === 'allMailFolderIds' && !isPlainRecord(settings[key])) {
                return;
              }
              // Defensive: a non-record (e.g. a legacy scalar) would break the
              // per-account map lookups - ignore it.
              if (key === 'preferredIdentityIds' && !isPlainRecord(settings[key])) {
                return;
              }
              if (DEVICE_LOCAL_SETTING_KEYS.has(key)) {
                return;
              }
              set({ [key]: settings[key] });
            }
          });

          // Apply visual settings
          applyFontSize(get().fontSize);
          applyDensity(get().density);
          applyAnimations(get().animationsEnabled);

          // Apply cross-store settings
          if (settings.theme) {
            useThemeStore.getState().setTheme(settings.theme);
          }
          if (settings.locale) {
            useLocaleStore.getState().setLocale(settings.locale);
          }

          return true;
        } catch (error) {
          console.error('Failed to import settings:', error);
          return false;
        }
      },

      // Folder icon methods
      setFolderIcon: (mailboxId: string, icon: string) => {
        set({ folderIcons: { ...get().folderIcons, [mailboxId]: icon } });
      },

      removeFolderIcon: (mailboxId: string) => {
        const { [mailboxId]: _, ...rest } = get().folderIcons;
        set({ folderIcons: rest });
      },

      // Shared-calendar color override methods
      setSharedCalendarColor: (key: string, color: string) => {
        set({ sharedCalendarColors: { ...get().sharedCalendarColors, [key]: color } });
      },

      removeSharedCalendarColor: (key: string) => {
        const { [key]: _, ...rest } = get().sharedCalendarColors;
        set({ sharedCalendarColors: rest });
      },

      // Trusted senders methods
      addTrustedSender: (email: string) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const emailAddress = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        const current = get().trustedSenders;
        if (!current.includes(emailAddress)) {
          set({ trustedSenders: [...current, emailAddress] });
        }
      },

      removeTrustedSender: (email: string) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const emailAddress = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        set({
          trustedSenders: get().trustedSenders.filter(e => e !== emailAddress)
        });
      },

      isSenderTrusted: (email: string) => {
        // Parse "Name <email>" format to extract just the email address
        const trimmed = email.trim();
        const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
        const emailAddress = (angleMatch ? angleMatch[2] : trimmed).toLowerCase().trim();
        return get().trustedSenders.includes(emailAddress);
      },

      // Keyword methods
      addKeyword: (keyword: KeywordDefinition) => {
        const current = get().emailKeywords;
        if (current.some(k => k.id === keyword.id)) return;
        set({ emailKeywords: [...current, keyword] });
      },

      updateKeyword: (id: string, updates: Partial<Omit<KeywordDefinition, 'id'>>) => {
        set({
          emailKeywords: get().emailKeywords.map(k =>
            k.id === id ? { ...k, ...updates } : k
          ),
        });
      },

      renameKeyword: (oldId: string, newKeyword: KeywordDefinition) => {
        set({
          emailKeywords: get().emailKeywords.map(k =>
            k.id === oldId ? newKeyword : k
          ),
        });
      },

      removeKeyword: (id: string) => {
        set({ emailKeywords: get().emailKeywords.filter(k => k.id !== id) });
      },

      reorderKeywords: (keywords: KeywordDefinition[]) => {
        set({ emailKeywords: keywords });
      },

      getKeywordById: (id: string) => {
        return get().emailKeywords.find(k => k.id === id);
      },

      // Sidebar Apps methods
      addSidebarApp: (app: SidebarApp) => {
        const current = get().sidebarApps;
        if (current.some(a => a.id === app.id)) return;
        set({ sidebarApps: [...current, app] });
      },

      updateSidebarApp: (id: string, updates: Partial<Omit<SidebarApp, 'id'>>) => {
        set({
          sidebarApps: get().sidebarApps.map(a =>
            a.id === id ? { ...a, ...updates } : a
          ),
        });
      },

      removeSidebarApp: (id: string) => {
        set({ sidebarApps: get().sidebarApps.filter(a => a.id !== id) });
      },

      reorderSidebarApps: (apps: SidebarApp[]) => {
        set({ sidebarApps: apps });
      },

      // Settings sync methods
      enableSync: (username: string, serverUrl: string) => {
        syncUsername = username;
        syncServerUrl = serverUrl;
        syncEnabled = true;
        syncLog('Settings sync enabled for', username);
      },

      disableSync: () => {
        syncEnabled = false;
        syncUsername = null;
        syncServerUrl = null;
        if (syncTimeout) {
          clearTimeout(syncTimeout);
          syncTimeout = null;
        }
        syncLog('Settings sync disabled');
      },

      loadFromServer: async (username: string, serverUrl: string) => {
        try {
          syncLog('Loading settings from server for', username);
          const res = await apiFetch('/api/settings', {
            headers: {
              'x-settings-username': username,
              'x-settings-server': serverUrl,
            },
          });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            syncLog('Settings fetch failed:', body.error || `status ${res.status}`);
            return false;
          }
          const { settings } = await res.json();
          if (!settings) {
            syncLog('No server settings found yet');
            return false;
          }
          if (settings && typeof settings === 'object') {
            isLoadingFromServer = true;
            get().importSettings(JSON.stringify(settings));
            isLoadingFromServer = false;
            syncLog('Settings loaded from server successfully');
            // Re-apply the (possibly server-updated) per-account preferred
            // sender identity to the already-loaded identities, so a fresh
            // browser reflects the synced default without waiting for the next
            // identity refresh. Dynamic import avoids a static import cycle
            // (auth-store imports this store). (#507)
            import('./auth-store')
              .then(({ useAuthStore }) => useAuthStore.getState().applyPreferredIdentityOrdering())
              .catch(() => {});
            return true;
          }
          return false;
        } catch (error) {
          syncError('Failed to load settings from server:', error);
          isLoadingFromServer = false;
          return false;
        }
      },
    }),
    {
      name: 'settings-storage',
      version: 5,
      migrate: (persisted, version) => {
        const state = persisted as Record<string, unknown>;
        if (version < 2 && state.listDensity) {
          state.density = state.listDensity;
          delete state.listDensity;
        }
        if (![0, 10, 30, 60].includes(state.sendDelaySeconds as number)) {
          state.sendDelaySeconds = 0;
        }
        if (version < 3 && typeof state.protocolOpenMode !== 'string' && typeof state.protocolMailtoOpenMode === 'string') {
          state.protocolOpenMode = state.protocolMailtoOpenMode;
        }
        delete state.protocolMailtoOpenMode;
        // v4: `dateFormat` was repurposed from 'regional'|'iso'|'custom' to
        // 'smart'|'relative'|'full'. The old setting was never read anywhere,
        // so every persisted value maps to the new default.
        if (version < 4) {
          state.dateFormat = 'smart';
        }
        // v5: allMailFolderIds went from a global `string[] | null` to a
        // per-account `Record<accountId, string[]>`. The legacy global list
        // can't be attributed to a specific account here (the active account
        // isn't known at migrate time), so it's dropped - each account starts
        // "not configured" (defaults to all no-role folders).
        if (version < 5 || !isPlainRecord(state.allMailFolderIds)) {
          state.allMailFolderIds = {};
        }
        return state as unknown as SettingsState;
      },
      onRehydrateStorage: () => {
        return (state) => {
          if (state) {
            // Defensive: a legacy global array or any non-record value (e.g.
            // synced from an older client) is coerced to an empty map so
            // per-account consumers never see a non-record.
            if (!isPlainRecord(state.allMailFolderIds)) {
              state.allMailFolderIds = {};
            }
            if (!isPlainRecord(state.preferredIdentityIds)) {
              state.preferredIdentityIds = {};
            }
            applyFontSize(state.fontSize);
            applyDensity(state.density);
            applyAnimations(state.animationsEnabled);
          }
        };
      },
    }
  )
);

// Helper functions to apply settings to DOM
function applyFontSize(size: FontSize) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  const sizeMap = {
    small: '14px',
    medium: '16px',
    large: '18px',
  };
  root.style.setProperty('--font-size-base', sizeMap[size]);
}

function applyDensity(density: Density) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;

  const densityValues = {
    'extra-compact': {
      '--list-item-height': 'auto',
      '--density-item-py': '2px',
      '--density-item-gap': '6px',
      '--density-header-py': '4px',
      '--density-card-p': '8px',
      '--density-sidebar-py': '0px',
    },
    compact: {
      '--list-item-height': 'auto',
      '--density-item-py': '4px',
      '--density-item-gap': '8px',
      '--density-header-py': '6px',
      '--density-card-p': '10px',
      '--density-sidebar-py': '1px',
    },
    regular: {
      '--list-item-height': '48px',
      '--density-item-py': '12px',
      '--density-item-gap': '12px',
      '--density-header-py': '12px',
      '--density-card-p': '16px',
      '--density-sidebar-py': '4px',
    },
    comfortable: {
      '--list-item-height': '64px',
      '--density-item-py': '16px',
      '--density-item-gap': '16px',
      '--density-header-py': '16px',
      '--density-card-p': '20px',
      '--density-sidebar-py': '6px',
    },
  };

  const values = densityValues[density];
  for (const [prop, val] of Object.entries(values)) {
    root.style.setProperty(prop, val);
  }
}

function applyAnimations(enabled: boolean) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  if (enabled) {
    root.style.removeProperty('--transition-duration');
  } else {
    root.style.setProperty('--transition-duration', '0s');
  }
}

// Initialize settings on load
if (typeof window !== 'undefined') {
  const store = useSettingsStore.getState();
  applyFontSize(store.fontSize);
  applyDensity(store.density);
  applyAnimations(store.animationsEnabled);

  // Shared sync function used by all store subscribers
  const syncToServer = async (retries = 1): Promise<void> => {
    const settings = JSON.parse(useSettingsStore.getState().exportSettings());
    syncLog('Syncing settings to server...');
    const res = await apiFetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: syncUsername, serverUrl: syncServerUrl, settings }),
    });
    if (res.status === 404) {
      syncWarn('Settings sync endpoint returned 404, disabling sync');
      syncEnabled = false;
    } else if (res.status === 403) {
      // Identity mismatch - current session cookies don't match the
      // username/serverUrl we're syncing for (common in dev mock mode where
      // no stalwart-context cookie is written, or when rememberMe is off).
      // Retrying won't help for this session; disable to stop the noise.
      syncWarn('Settings sync rejected (identity mismatch), disabling sync');
      syncEnabled = false;
    } else if (res.status >= 500 && retries > 0) {
      const body = await res.json().catch(() => ({}));
      syncWarn('Settings sync got server error:', body.error || `status ${res.status}`, '- retrying...');
      await new Promise((r) => setTimeout(r, 2000));
      return syncToServer(retries - 1);
    } else if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      syncError('Settings sync failed:', body.error || `status ${res.status}`);
    } else {
      syncLog('Settings synced to server successfully');
    }
  };

  const triggerSync = () => {
    if (!syncEnabled || !syncUsername || !syncServerUrl || isLoadingFromServer) return;
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
      try {
        await syncToServer();
      } catch (error) {
        syncError('Settings sync error:', error);
      }
    }, SYNC_DEBOUNCE_MS);
  };

  // Auto-sync settings to server on any state change
  let prevSyncDisabled = useSettingsStore.getState().settingsSyncDisabled;
  useSettingsStore.subscribe(() => {
    const currentSyncDisabled = useSettingsStore.getState().settingsSyncDisabled;
    const syncToggleChanged = currentSyncDisabled !== prevSyncDisabled;
    prevSyncDisabled = currentSyncDisabled;
    // Skip sync if disabled, unless the toggle itself just changed
    if (currentSyncDisabled && !syncToggleChanged) return;
    triggerSync();
  });

  // Also sync when theme or locale changes
  useThemeStore.subscribe(triggerSync);
  useLocaleStore.subscribe(triggerSync);
}
