// The settings a plugin may change for the user (app.setSettings, permission
// settings:change), with where each one is shown and which values it may
// take. Built from the settings pages: the label of each row, its page and
// the labels of its values are the page's own locale keys, so the assistant
// asks "Time format: 12-hour → 24-hour" in the words the user sees.
//
// Everything not listed here is refused. What stays out on purpose (privacy,
// anything that sends mail or data elsewhere, deleting, free text that goes
// into sent mail, maps keyed by server ids) is listed in DENIED_SETTINGS, so
// a test can tell a forgotten key from a refused one.
//
// The run-time checks (an admin lock, a hidden row, a restriction's values,
// the feature gate that shows the row) live with the caller
// (lib/plugin-sandbox/assistant/c.settings.ts); this file is the table and
// the pure value checks.

import type { SettingsSearchTab } from '@/lib/settings-search';
import type { FeatureGates } from '@/lib/admin/types';
import {
  ACCESSIBILITY_ALLOWED,
  FONT_SIZES,
  MAIL_MIN_FONT_SIZES,
  MAIL_TEXT_SCALES,
  READ_ALOUD_RATES,
  TOAST_DURATIONS,
  UNLOCKABLE_SETTING_KEYS,
} from '@/lib/accessibility-settings';
import { locales } from '@/i18n/routing';

/** Which store holds the setting. */
export type SettingsStoreName = 'settings' | 'theme' | 'locale' | 'calendar';

/** A value the user can pick, with the locale key of its label (null: formatted, e.g. hours). */
export interface SettingOption {
  value: string | number;
  label: string | null;
  /** Shown as is when the page does not translate it (a font name, "16px"). Only with label null. */
  text?: string;
  /** The page offers this value only while the gate is on (the archive choices). */
  gate?: keyof FeatureGates;
}

export type SettingKind =
  /** On or off. `only` limits it to one direction (confirmDelete may only be turned on). */
  | { type: 'boolean'; only?: boolean }
  /** One of a fixed list. Values not in `options` are refused. */
  | { type: 'choice'; options: SettingOption[] }
  /** A whole hour from min to max (calendar hours). */
  | { type: 'hour'; min: number; max: number }
  /** 'auto' or an IANA time zone this browser knows. */
  | { type: 'timeZone' }
  /** '' (the browser's) or a locale the app has. */
  | { type: 'locale' }
  /** Days of the week 0-6, unique, at least one. */
  | { type: 'days' }
  /** A list of short words: trimmed, unique, no line breaks; lowercase when `lowercase` is set. */
  | { type: 'words'; max: number; maxLength: number; lowercase?: boolean }
  /** A list of ids from `options`, unique. */
  | { type: 'list'; options: SettingOption[]; min?: number };

export interface SettingSchemaEntry {
  key: string;
  store: SettingsStoreName;
  /** The settings page the row is on. */
  page: SettingsSearchTab;
  /** Locale key of the row's label. */
  label: string;
  kind: SettingKind;
  /** The feature gate that shows the row; the change is refused while it is off. */
  gate?: keyof FeatureGates;
  /** The row is hidden in no-third-party mode (it fetches from elsewhere). */
  thirdParty?: boolean;
  /** An admin lock acts as a default for this key (UNLOCKABLE_SETTING_KEYS), so it doesn't refuse. */
  preset?: boolean;
  /** The label says the opposite of the value (disableThreading: "Group conversations"). */
  inverted?: boolean;
}

/** Locale keys of the labels for on and off. */
export const ON_LABEL = 'settings.accessibility.on';
export const OFF_LABEL = 'settings.accessibility.off';

/**
 * Pages the settings app shows only while a feature gate is on. A key on
 * such a page is refused while the gate is off, on top of its own `gate`.
 */
export const PAGE_GATES: Readonly<Partial<Record<SettingsSearchTab, keyof FeatureGates>>> = {
  calendar: 'calendarEnabled',
  contacts: 'contactsEnabled',
  files: 'filesEnabled',
};

// The ids below live in modules that import the settings store (the hover
// actions, the month view styles) or the editor (the compose sizes). They are
// copied here so this table stays free of stores; the test checks each copy
// against its source.

/** ALL_HOVER_ACTIONS in stores/settings-store.ts, with their labelKey. */
export const HOVER_ACTION_IDS = [
  ['delete', 'delete'], ['star', 'star'], ['markRead', 'mark_read'], ['archive', 'archive'], ['tag', 'tag'], ['spam', 'spam'],
] as const;
/** MONTH_TIMED_EVENT_STYLES in stores/settings-store.ts. */
export const MONTH_TIMED_EVENT_STYLE_IDS = ['bar', 'text', 'dot'] as const;
/** NOTIFICATION_SOUNDS in lib/notification-sound.ts (it imports lib/debug, which imports the store). */
export const NOTIFICATION_SOUND_IDS = ['default', 'cheerful', 'involved', 'swift', 'relax'] as const;
/** FONT_SIZES in components/email/font-size.ts (the composer's sizes). */
export const COMPOSE_FONT_SIZE_IDS = ['14px', '16px', '18px', '20px', '24px', '32px'] as const;

// --- Builders ----------------------------------------------------------------

type Extra = Pick<SettingSchemaEntry, 'gate' | 'thirdParty' | 'inverted'> & { store?: SettingsStoreName };

function entry(key: string, page: SettingsSearchTab, label: string, kind: SettingKind, extra: Extra = {}): SettingSchemaEntry {
  const { store = 'settings', ...rest } = extra;
  const out: SettingSchemaEntry = { key, store, page, label, kind, ...rest };
  if (store === 'settings' && UNLOCKABLE_SETTING_KEYS.has(key)) out.preset = true;
  return out;
}

function bool(key: string, page: SettingsSearchTab, label: string, extra: Extra & { only?: boolean } = {}): SettingSchemaEntry {
  const { only, ...rest } = extra;
  return entry(key, page, label, only === undefined ? { type: 'boolean' } : { type: 'boolean', only }, rest);
}

/** Options whose label key is `prefix` + a suffix (the value itself unless mapped). */
function opts(prefix: string, values: readonly (string | number)[], suffix: Record<string, string> = {}): SettingOption[] {
  return values.map((value) => ({ value, label: prefix + (suffix[String(value)] ?? String(value)) }));
}

function choice(key: string, page: SettingsSearchTab, label: string, options: SettingOption[], extra: Extra = {}): SettingSchemaEntry {
  return entry(key, page, label, { type: 'choice', options }, extra);
}

/** The values ACCESSIBILITY_ALLOWED lists for `key`, so the table can't drift from the import check. */
function allowed(key: string): readonly (string | number)[] {
  const values = ACCESSIBILITY_ALLOWED[key];
  if (!values) throw new Error(`settings-schema: no ACCESSIBILITY_ALLOWED list for ${key}`);
  return values as readonly (string | number)[];
}

const A = 'settings.accessibility.';
const AP = 'settings.appearance.';
const EB = 'settings.email_behavior.';
const LR = 'settings.language_region.';
const CAL = 'calendar.settings.';
const DL = 'settings.downloads.';
const NO = 'settings.notifications.';

/** Off / On / System radio of the accessibility page. */
const systemToggle = (key: string) => opts(A, allowed(key));

const SWIPE_OPTIONS: SettingOption[] = [
  { value: 'none', label: `${EB}swipe_actions.none` },
  { value: 'archive', label: `${EB}swipe_actions.archive`, gate: 'archiveActionEnabled' },
  { value: 'delete', label: `${EB}swipe_actions.delete` },
  { value: 'markRead', label: `${EB}swipe_actions.mark_read` },
  { value: 'star', label: `${EB}swipe_actions.star` },
  { value: 'spam', label: `${EB}swipe_actions.spam` },
];

const ENTRIES: SettingSchemaEntry[] = [
  // --- Appearance ---
  choice('theme', 'appearance', `${AP}theme.label`, opts(`${AP}theme.`, ['light', 'dark', 'system']), { store: 'theme' }),
  choice('density', 'appearance', `${AP}list_density.label`,
    opts(`${AP}list_density.`, ['extra-compact', 'compact', 'regular', 'comfortable'], { 'extra-compact': 'extra_compact' })),
  choice('interfaceLayout', 'appearance', `${AP}interface_layout.label`,
    opts(`${AP}interface_layout.`, ['default', 'mountain-view'], { 'mountain-view': 'mountain_view' })),
  choice('mailLayout', 'appearance', `${EB}mail_layout.label`, opts(`${EB}mail_layout.`, ['split', 'focus', 'horizontal'])),
  choice('toolbarPosition', 'appearance', `${AP}toolbar_position.label`,
    opts(`${AP}toolbar_position.`, ['top', 'below-subject'], { 'below-subject': 'below_subject' })),
  bool('showToolbarLabels', 'appearance', `${AP}toolbar_labels.label`),
  bool('colorfulSidebarIcons', 'appearance', `${AP}colorful_sidebar_icons.label`),
  bool('showFolderTotalCount', 'appearance', `${AP}show_folder_total_count.label`),
  bool('sidebarAccountSwitcher', 'appearance', `${AP}sidebar_account_switcher.label`),
  bool('showRailAccountList', 'appearance', `${AP}show_rail_account_list.label`),
  bool('proInterface', 'appearance', `${AP}pro_interface.label`),
  bool('enableUnifiedMailbox', 'appearance', `${AP}unified_mailbox.label`),
  bool('unifiedCrossAccount', 'appearance', `${AP}unified_mailbox.cross_account.label`, { gate: 'unifiedCrossAccountEnabled' }),
  bool('includeGroupInUnified', 'appearance', `${AP}unified_mailbox.include_group.label`),
  bool('enableCrossUnreadView', 'appearance', `${AP}cross_unread.label`, { gate: 'crossUnreadViewEnabled' }),
  bool('enableCrossStarredView', 'appearance', `${AP}cross_starred.label`, { gate: 'crossStarredViewEnabled' }),
  bool('enableCrossAllView', 'appearance', `${AP}cross_all.label`, { gate: 'crossAllViewEnabled' }),
  // One radio on the page (dot / tint / none) writes both keys.
  bool('tintListRowsByAccount', 'appearance', `${AP}account_marker.label`),
  bool('showAccountDot', 'appearance', `${AP}account_marker.label`),
  bool('showSharedMailAccounts', 'appearance', `${AP}show_shared_mail_accounts.label`),
  bool('compactSharedMailboxes', 'appearance', `${AP}compact_shared_mailboxes.label`),
  // The sidebar switch of the settings app; it has no page of its own.
  bool('showAdvancedSettings', 'general', 'settings.advanced_switch.label'),

  // --- Language and region, General ---
  entry('locale', 'general', `${LR}language.label`, { type: 'locale' }, { store: 'locale' }),
  choice('dateFormat', 'general', `${LR}date_format.label`, opts(`${LR}date_format.`, ['smart', 'relative', 'full'])),
  choice('dateLocale', 'general', `${LR}date_locale.label`,
    opts(`${LR}date_locale.`, ['auto', 'iso', 'en-GB', 'en-US'], { 'en-GB': 'dmy', 'en-US': 'mdy' })),
  choice('timeFormat', 'general', `${LR}time_format.label`, opts(`${LR}time_format.`, ['12h', '24h'])),
  entry('timeZone', 'general', `${LR}time_zone.label`, { type: 'timeZone' }),
  choice('firstDayOfWeek', 'general', `${LR}first_day.label`,
    opts('calendar.days.', [1, 6, 0], { 1: 'monday', 6: 'saturday', 0: 'sunday' })),
  choice('protocolOpenMode', 'general', 'protocol_handlers.protocol_open_mode_label',
    opts('protocol_handlers.protocol_open_mode_', ['new-tab', 'active-session'], { 'new-tab': 'new_tab', 'active-session': 'active_session' })),
  bool('showOnboardingOnNewDevices', 'general', 'tour.show_on_new_devices_title'),

  // --- Message list ---
  bool('disableThreading', 'message_list', `${EB}group_conversations.label`, { inverted: true }),
  bool('groupListByDate', 'message_list', `${EB}group_by_date.label`),
  bool('showPreview', 'message_list', `${EB}show_preview.label`),
  bool('listColumns', 'message_list', `${EB}list_columns.label`),
  choice('mvInboxType', 'message_list', `${EB}inbox_type.label`,
    opts(`${EB}inbox_type.`, ['default', 'unread-first'], { 'unread-first': 'unread_first' })),
  // A switch on the page: on = every folder.
  choice('messageListOrderScope', 'message_list', `${AP}message_list_order.scope.label`, [
    { value: 'inbox', label: OFF_LABEL },
    { value: 'all', label: ON_LABEL },
  ]),
  bool('tintListRowsByTag', 'message_list', `${AP}tint_list_rows.label`),
  bool('showVerificationCodes', 'message_list', `${EB}show_verification_codes.label`),
  bool('showAttachmentChips', 'message_list', `${EB}show_attachment_chips.label`),
  bool('showTagChips', 'message_list', `${EB}show_tag_chips.label`),
  // Both make the server fetch the sender's domain: the assistant may only switch them off.
  bool('senderFavicons', 'privacy', 'settings.advanced.sender_favicons.label', { thirdParty: true, only: false }),
  bool('showAvatarsInJunk', 'privacy', 'settings.advanced.show_avatars_in_junk.label', { thirdParty: true, only: false }),
  entry('hoverActions', 'message_list', `${EB}hover_actions.label`, {
    type: 'list',
    options: HOVER_ACTION_IDS.map(([value, labelKey]) => ({
      value,
      label: `${EB}hover_actions.${labelKey}`,
      ...(value === 'archive' ? { gate: 'archiveActionEnabled' as const } : {}),
    })),
  }, { gate: 'hoverActionsConfigEnabled' }),
  choice('hoverActionsMode', 'message_list', `${EB}hover_actions.mode_label`,
    opts(`${EB}hover_actions.mode_`, ['inline', 'floating']), { gate: 'hoverActionsConfigEnabled' }),
  choice('hoverActionsCorner', 'message_list', `${EB}hover_actions.corner_label`,
    opts(`${EB}hover_actions.corner_`, ['top-left', 'top-right', 'bottom-left', 'bottom-right']), { gate: 'hoverActionsConfigEnabled' }),
  choice('swipeRightAction', 'message_list', `${EB}swipe_right_action.label`, SWIPE_OPTIONS),
  choice('swipeLeftAction', 'message_list', `${EB}swipe_left_action.label`, SWIPE_OPTIONS),
  // No "permanent": it makes every later delete final.
  choice('deleteAction', 'message_list', `${EB}delete_action.label`,
    opts(`${EB}delete_action.`, ['trash', 'trash-and-read'], { 'trash-and-read': 'trash_and_read' })),
  choice('archiveMode', 'message_list', `${EB}archive_mode.label`, opts(`${EB}archive_mode.`, ['single', 'year', 'month']),
    { gate: 'archiveActionEnabled' }),
  // Delete safety nets: a plugin may turn them on, never off.
  bool('confirmBulkDelete', 'message_list', `${EB}confirm_bulk_delete.label`, { only: true }),
  bool('permanentlyDeleteJunk', 'message_list', `${EB}permanently_delete_junk.label`, { only: false }),
  choice('emailsPerPage', 'message_list', `${EB}emails_per_page.label`, opts(`${EB}emails_per_page.`, [10, 25, 50, 100])),
  choice('searchDefaultScope', 'message_list', `${EB}search_default_scope.label`, opts(`${EB}search_default_scope.`, ['all', 'folder'])),
  bool('clearSearchOnFolderChange', 'message_list', `${EB}clear_search_on_folder_change.label`),

  // --- Reading ---
  choice('markAsReadDelay', 'reading', `${EB}mark_read.label`,
    opts(`${EB}mark_read.`, [0, 3000, 5000, -1], { 0: 'instant', 3000: 'delay_3s', 5000: 'delay_5s', '-1': 'never' })),
  bool('returnToListAfterAction', 'reading', `${EB}return_to_list_after_action.label`),
  choice('messageSpacing', 'reading', `${EB}message_spacing.label`, opts(`${EB}message_spacing.`, ['auto', 'always', 'edge'])),
  bool('emailAlwaysLightMode', 'reading', `${EB}always_light_mode.label`),
  choice('mailAttachmentAction', 'reading', `${EB}attachment_click_action.label`,
    opts(`${EB}attachment_click_action.`, ['preview', 'download'])),
  bool('attachmentImagePreviewsEnabled', 'reading', `${EB}attachment_image_previews.label`),
  bool('hideInlineImageAttachments', 'reading', `${EB}hide_inline_image_attachments.label`),
  choice('filenameSpaceReplacement', 'reading', `${DL}spaces.label`, opts(`${DL}spaces.`, ['keep', 'underscore', 'dash'])),
  bool('filenameLowercase', 'reading', `${DL}lowercase.label`),
  bool('filenameStripDiacritics', 'reading', `${DL}strip_diacritics.label`),
  bool('filenameCollapseSeparators', 'reading', `${DL}collapse_separators.label`),
  // No "trash": it deletes the exported mail.
  choice('postExportAction', 'reading', `${DL}after_export.label`, [
    { value: 'keep', label: `${DL}after_export.keep` },
    { value: 'archive', label: `${DL}after_export.archive`, gate: 'archiveActionEnabled' },
  ]),

  // --- Composing ---
  bool('plainTextMode', 'composing', `${EB}plain_text_mode.label`),
  bool('recipientMentionsEnabled', 'composing', `${EB}recipient_mentions.label`),
  choice('mentionAddsRecipientTo', 'composing', `${EB}mention_adds_recipient.label`,
    opts(`${EB}mention_adds_recipient.`, ['to', 'cc', 'off'])),
  bool('rtlEditingSupport', 'composing', `${EB}rtl_editing.label`),
  bool('replyUnderMessage', 'composing', `${EB}reply_under_message.label`),
  bool('quickReplyEnabled', 'composing', `${EB}quick_reply.label`),
  bool('autoSelectReplyIdentity', 'composing', 'compose_words.reply_from_received.label'),
  // The page shows it only while the composer may rewrite From.
  choice('replyIdentityMatch', 'composing', `${EB}reply_identity_match.label`,
    opts(`${EB}reply_identity_match.`, ['exact', 'domain']), { gate: 'customFromEnabled' }),
  choice('signaturePosition', 'composing', `${EB}signature_position.label`,
    opts(`${EB}signature_position.`, ['above_quote', 'below_quote'])),
  bool('signatureNewMailEnabled', 'composing', `${EB}signature_new_mail.label`),
  bool('signatureReplyForwardEnabled', 'composing', `${EB}signature_reply_forward.label`),
  bool('signatureSeparatorEnabled', 'composing', `${EB}signature_separator.label`),
  // 5/10/30 read "{seconds} seconds" (send_delay.seconds): formatted.
  choice('sendDelaySeconds', 'composing', 'compose_words.undo_send.label', [
    { value: 0, label: `${EB}send_delay.off` },
    { value: 5, label: null },
    { value: 10, label: null },
    { value: 30, label: null },
  ]),
  bool('sendConfirmation', 'accessibility', `${A}confirm_send.label`),
  bool('attachmentReminderEnabled', 'composing', `${EB}attachment_reminder.label`),
  // The page trims and lowercases what the user types.
  entry('attachmentReminderKeywords', 'composing', `${EB}attachment_reminder.keywords_label`,
    { type: 'words', max: 50, maxLength: 40, lowercase: true }),
  bool('emptySubjectWarningEnabled', 'composing', `${EB}empty_subject_warning.label`),
  bool('placeholderWarningEnabled', 'composing', `${EB}placeholder_warning.label`),
  bool('requestReadReceiptDefault', 'privacy', `${EB}request_read_receipt.label`),
  // No "always": that sends a receipt mail by itself.
  choice('readReceiptResponse', 'privacy', `${EB}read_receipt_response.label`,
    opts(`${EB}read_receipt_response.`, ['ask', 'never'])),

  // --- Notifications ---
  bool('emailNotificationsEnabled', 'notifications', `${NO}email.enabled`),
  bool('emailNotificationSound', 'notifications', `${NO}email.sound`),
  choice('notificationSoundChoice', 'notifications', `${NO}sound_selection.choose`, opts(`${NO}sounds.`, NOTIFICATION_SOUND_IDS)),
  bool('pushNotifyInboxOnly', 'notifications', `${NO}email.inbox_only`),
  bool('faviconUnreadBadge', 'notifications', `${AP}favicon_unread_badge.label`),
  bool('unreadBadgeAllAccounts', 'notifications', 'account_unread.badge_all_accounts.label'),
  bool('calendarNotificationsEnabled', 'notifications', `${NO}calendar.enabled`),
  bool('calendarNotificationSound', 'notifications', `${NO}calendar.sound`),
  // On Notifications since settings-p3-6, as "Pause notifications"; the key stays.
  bool('doNotDisturb', 'notifications', 'ux_p3_words.pause_label'),
  bool('visualAlerts', 'accessibility', `${A}visual_alerts.label`),
  // Seconds read "{seconds} seconds": formatted. The admin minimum is checked at run time.
  choice('toastDuration', 'accessibility', `${A}toast_duration.label`,
    TOAST_DURATIONS.map((value) => ({ value, label: value === 0 ? `${A}toast_duration.until_closed` : null }))),

  // --- Calendar ---
  choice('viewMode', 'calendar', `${CAL}default_view`, opts('calendar.views.', ['month', 'week', 'day', 'agenda']), { store: 'calendar' }),
  bool('calendarInvitationParsingEnabled', 'calendar', `${CAL}invitation_parsing`),
  bool('showTimeInMonthView', 'calendar', `${CAL}show_time_in_month_view`),
  bool('calendarTintedEvents', 'calendar', `${CAL}tinted_events`),
  choice('calendarMonthTimedEvents', 'calendar', `${CAL}month_timed_events`, opts(`${CAL}month_timed_events_`, MONTH_TIMED_EVENT_STYLE_IDS)),
  bool('showWeekNumbers', 'calendar', `${CAL}show_week_numbers`),
  bool('calendarLimitHours', 'calendar', `${CAL}limit_hours`),
  // End after start is checked at run time, across both keys.
  entry('calendarDayStartHour', 'calendar', `${CAL}visible_hours`, { type: 'hour', min: 0, max: 23 }),
  entry('calendarDayEndHour', 'calendar', `${CAL}visible_hours`, { type: 'hour', min: 1, max: 24 }),
  bool('calendarHideNonWorkingDays', 'calendar', `${CAL}hide_non_working_days`),
  entry('calendarWorkingDays', 'calendar', `${CAL}working_days`, { type: 'days' }),
  bool('calendarFreeScroll', 'calendar', `${CAL}calendar_free_scroll`),
  choice('calendarHoverPreview', 'calendar', `${CAL}hover_preview`,
    opts(`${CAL}hover_preview_`, ['instant', 'delay-500ms', 'delay-1s', 'delay-2s', 'off'],
      { 'delay-500ms': 'delay_500ms', 'delay-1s': 'delay_1s', 'delay-2s': 'delay_2s' })),
  bool('showBirthdayCalendar', 'calendar', `${CAL}show_birthday_calendar`),
  bool('enableCalendarTasks', 'calendar', `${CAL}enable_tasks`, { gate: 'calendarTasksEnabled' }),
  bool('showTasksOnCalendar', 'calendar', `${CAL}show_tasks_on_calendar`, { gate: 'calendarTasksEnabled' }),

  // --- Contacts ---
  bool('groupContactsByLetter', 'contacts', 'settings.contacts.group_by_letter_label'),
  bool('sortContactsByLastName', 'contacts', 'settings.contacts.sort_by_last_name_label'),
  bool('showContactsDirectory', 'contacts', 'settings.contacts.show_directory_label'),

  // --- Accessibility ---
  bool('showAccessibilityButton', 'accessibility', `${A}quick_button.label`),
  choice('fontSize', 'accessibility', `${A}text_size.label`, opts(`${A}text_size.`, FONT_SIZES)),
  choice('appFont', 'accessibility', `${A}font.label`, [
    { value: 'default', label: `${A}font.default` },
    { value: 'atkinson', label: null, text: 'Atkinson Hyperlegible' },
    { value: 'lexend', label: null, text: 'Lexend' },
    { value: 'opendyslexic', label: null, text: 'OpenDyslexic' },
  ]),
  choice('plainTextFont', 'accessibility', `${A}plain_text_font.label`, opts(`${A}plain_text_font.`, ['sans', 'mono'])),
  choice('lineSpacing', 'accessibility', `${A}line_spacing.label`, opts(`${A}spacing.`, allowed('lineSpacing'))),
  choice('letterSpacing', 'accessibility', `${A}letter_spacing.label`, opts(`${A}spacing.`, allowed('letterSpacing'))),
  choice('wordSpacing', 'accessibility', `${A}word_spacing.label`, opts(`${A}spacing.`, allowed('wordSpacing'))),
  choice('paragraphSpacing', 'accessibility', `${A}paragraph_spacing.label`, opts(`${A}spacing.`, allowed('paragraphSpacing'))),
  choice('readingWidth', 'accessibility', `${A}reading_width.label`, opts(`${A}reading_width.`, allowed('readingWidth'))),
  bool('readingMask', 'accessibility', `${A}reading_mask.label`),
  choice('contrast', 'accessibility', `${A}contrast.label`, [
    { value: 'system', label: `${A}system` },
    { value: 'more', label: `${A}contrast.more` },
    { value: 'normal', label: `${A}contrast.normal` },
  ]),
  choice('reduceTransparency', 'accessibility', `${A}transparency.label`, systemToggle('reduceTransparency')),
  bool('underlineLinks', 'accessibility', `${A}underline_links.label`),
  bool('showColorNames', 'accessibility', `${A}color_names.label`),
  bool('colorBlindPalette', 'accessibility', `${A}cvd_palette.label`),
  choice('reduceMotion', 'accessibility', `${A}reduce_motion.label`, systemToggle('reduceMotion')),
  choice('pauseAnimatedImages', 'accessibility', `${A}pause_images.label`, systemToggle('pauseAnimatedImages')),
  bool('singleKeyShortcuts', 'accessibility', `${A}single_key_shortcuts.label`),
  choice('focusRing', 'accessibility', `${A}focus_ring.label`, opts(`${A}focus_ring.`, allowed('focusRing'))),
  bool('focusAlwaysVisible', 'accessibility', `${A}focus_always.label`),
  choice('largeTargets', 'accessibility', `${A}large_targets.label`, systemToggle('largeTargets')),
  bool('largeCursor', 'accessibility', `${A}large_cursor.label`),
  bool('openOnHover', 'accessibility', `${A}open_on_hover.label`),
  bool('showRowActionButton', 'accessibility', `${A}row_action_button.label`),
  bool('nativeScrollbars', 'accessibility', `${A}native_scrollbars.label`),
  choice('mailViewMode', 'accessibility', `${A}mail_view.label`, opts(`${A}mail_view.`, allowed('mailViewMode'))),
  // Percentages: formatted, except 0 ("follow the interface").
  choice('mailTextScale', 'accessibility', `${A}mail_text_size.label`,
    MAIL_TEXT_SCALES.map((value) => ({ value, label: value === 0 ? `${A}mail_text_size.follow` : null }))),
  // "{size} px": formatted, except 0 ("none").
  choice('mailMinFontSize', 'accessibility', `${A}mail_min_font_size.label`,
    MAIL_MIN_FONT_SIZES.map((value) => ({ value, label: value === 0 ? `${A}mail_min_font_size.none` : null }))),
  choice('mailOverrideStyles', 'accessibility', `${A}mail_override.label`,
    opts(`${A}mail_override.`, allowed('mailOverrideStyles'), { 'high-contrast': 'high_contrast' })),
  bool('mailFitWidth', 'accessibility', `${A}mail_fit_width.label`),
  // "1.25×": formatted.
  choice('readAloudRate', 'accessibility', `${A}read_aloud_rate.label`, READ_ALOUD_RATES.map((value) => ({ value, label: null }))),
  // Only the fonts and sizes the page offers: a free CSS value must not reach the composer.
  choice('composeFontFamily', 'accessibility', `${A}compose_font.label`,
    opts(`${A}compose_font.`, ['', 'sans-serif', 'serif', 'monospace'], { '': 'default', 'sans-serif': 'sans', monospace: 'mono' })),
  choice('composeFontSize', 'accessibility', `${A}compose_size.label`, [
    { value: '', label: `${A}compose_size.default` },
    ...COMPOSE_FONT_SIZE_IDS.map((size) => ({ value: size, label: null, text: size })),
  ]),
  // A delete safety net: on only.
  bool('confirmDelete', 'accessibility', `${A}confirm_delete.label`, { only: true }),
  bool('confirmArchive', 'accessibility', `${A}confirm_archive.label`),
  choice('unreadCountStyle', 'accessibility', `${A}unread_counts.label`, opts(`${A}unread_counts.`, allowed('unreadCountStyle'))),
  bool('announceNewMail', 'accessibility', `${A}announce_new_mail.label`),
  bool('announceRowPreview', 'accessibility', `${A}announce_preview.label`),
  bool('simpleMode', 'accessibility', `${A}simple_mode.label`),
  bool('simpleModePagedList', 'accessibility', `${A}simple_mode_paged.label`),
];

/** The settings a plugin may change, by key. */
export const SETTINGS_SCHEMA: Readonly<Record<string, SettingSchemaEntry>> = Object.freeze(
  Object.fromEntries(ENTRIES.map((e) => [e.key, e])),
);

/**
 * Settings refused on purpose (see the file header), grouped by why.
 */
export const DENIED_SETTINGS: readonly string[] = [
  // Privacy: loads remote content, or says who may.
  'externalContentPolicy', 'trustedSenders', 'trustedSendersAddressBook',
  // Free text that ends up in file names or in every sent mail.
  'emailDownloadTemplate', 'attachmentDownloadTemplate', 'bundleDownloadTemplate', 'signatureDetails',
  // Never read by the app (defaultReplyMode, hideAccountSwitcher: the sidebar's
  // switcher it hid is gone), or on the account page (the delimiter).
  'defaultReplyMode', 'hideAccountSwitcher', 'subAddressDelimiter',
  // Sends push metadata to another server.
  'pushRelayUrl',
  // Turning proofreading on sends what the user writes to a checker plugin.
  'proofreading', 'proofreadingPlugins',
  // A browser voice id the model can't know.
  'readAloudVoice',
  // Maps and lists keyed by server ids.
  'allMailFolderIds', 'hiddenSharedMailAccounts', 'sharedMailAccountOrder', 'notificationMutes', 'hiddenCompanyCalendars', 'sharedCalendarColors',
  'folderIcons', 'folderCountModes', 'preferredIdentityIds',
  // App bookkeeping and UI state, not preferences.
  'onboardingCompleted', 'tourCompleted', 'emailKeywordsChoiceTracked', 'mvUnreadSectionCollapsed', 'mvEverythingElseCollapsed',
  'vacationCalendarBlocks', 'explicitSettings', 'proofreadingNoticeSeen',
  // Security, debugging and sync.
  'sessionTimeout', 'debugMode', 'debugCategories', 'settingsSyncDisabled',
  // Tags (they have their own keywords.* actions), filters and add-ons.
  'emailKeywords', 'nestedTags', 'expandedFilterView', 'sidebarApps', 'keepAppsLoaded',
];

/**
 * Allowed in principle but not built yet: each needs more than a value
 * check.
 * - messageListOrder: a list of sort levels (sanitizeSortLevels).
 * - filesSettings: an object; each sub-key would need its own row.
 * - activeThemeId (theme store): an installed theme id; disabled and forced themes.
 * - birthdayCalendarColor: a colour, set in the calendar app, not in Settings.
 * - vacationBlockCalendar: the page also adds or removes the busy event
 *   (vacationBlockChanged); updateSetting alone would not.
 * - writingLanguage: a language from lib/proofreading/languages, and the
 *   organisation policy may pin it.
 */
export const NOT_YET_SETTINGS: readonly string[] = [
  'messageListOrder', 'filesSettings', 'activeThemeId', 'birthdayCalendarColor', 'vacationBlockCalendar',
  'writingLanguage', 'calendarNarrowWeekAllDays',
  // A plugin's print style: offered only while that plugin runs.
  'printTheme',
];

/** Line breaks, tabs and other control characters. */
const CONTROL_CHARS = /\p{Cc}/u;

/** An IANA zone id this runtime knows, spelled as Intl spells it ("Europe/Berlin", "UTC"). */
function isKnownTimeZone(value: string): boolean {
  if (!value || value.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    if (intl.supportedValuesOf?.('timeZone').includes(value)) return true;
  } catch {
    // fall through to the DateTimeFormat check
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone === value;
  } catch {
    return false;
  }
}

function isUniqueList(value: unknown[]): boolean {
  return new Set(value).size === value.length;
}

/** Whether `value` is one the setting may take (the table's limits only; restrictions are checked at run time). */
export function isAllowedSettingValue(entry: SettingSchemaEntry, value: unknown): boolean {
  const kind = entry.kind;
  switch (kind.type) {
    case 'boolean':
      return typeof value === 'boolean' && (kind.only === undefined || value === kind.only);
    case 'choice':
      return kind.options.some((option) => option.value === value);
    case 'hour':
      return typeof value === 'number' && Number.isInteger(value) && value >= kind.min && value <= kind.max;
    case 'timeZone':
      return typeof value === 'string' && (value === 'auto' || isKnownTimeZone(value));
    case 'locale':
      return typeof value === 'string' && (value === '' || value === 'auto' || (locales as readonly string[]).includes(value));
    case 'days':
      return Array.isArray(value) && value.length >= 1 && value.length <= 7 && isUniqueList(value)
        && value.every((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6);
    case 'words':
      return Array.isArray(value) && value.length <= kind.max && isUniqueList(value)
        && value.every((word) => typeof word === 'string' && word.length >= 1 && word.length <= kind.maxLength
          && word === word.trim() && !CONTROL_CHARS.test(word) && (!kind.lowercase || word === word.toLowerCase()));
    case 'list':
      return Array.isArray(value) && value.length >= (kind.min ?? 0) && isUniqueList(value)
        && value.every((item) => kind.options.some((option) => option.value === item));
  }
}

/**
 * The locale key of the label for `value`: ON_LABEL / OFF_LABEL for a switch
 * (turned round for an inverted one), the option's label for a choice, the
 * "Automatic" label for timeZone 'auto'. Null when the value is formatted or
 * shown as is (hours, seconds, zone ids, languages, lists).
 */
export function settingValueLabelKey(entry: SettingSchemaEntry, value: unknown): string | null {
  const kind = entry.kind;
  switch (kind.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return null;
      return (entry.inverted ? !value : value) ? ON_LABEL : OFF_LABEL;
    case 'choice':
      return kind.options.find((option) => option.value === value)?.label ?? null;
    case 'timeZone':
      return value === 'auto' ? `${LR}time_zone.auto` : null;
    default:
      return null;
  }
}
