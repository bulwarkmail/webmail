// Settings search index helpers: which translation subtrees each settings tab
// renders, extra keywords per tab, and the walker that turns those subtrees
// into clickable sub-results. Kept free of React so it can be unit-tested.

export type SettingsSearchTab =
  | 'account'
  | 'general'
  | 'notifications'
  | 'appearance'
  | 'accessibility'
  | 'message_list'
  | 'reading'
  | 'composing'
  | 'vacation'
  | 'filters'
  | 'organize'
  | 'security'
  | 'sharing'
  | 'recovery'
  | 'calendar'
  | 'contacts'
  | 'files'
  | 'addons'
  | 'backup';

type Tab = SettingsSearchTab;

/** A row a settings page draws only in some situations. */
export type SettingsSearchCondition =
  /** A touch screen (pointer: coarse), e.g. the swipe actions. */
  | 'touch'
  /** The Mountain View interface layout. */
  | 'mountainView'
  /** More than one account signed in. */
  | 'multiAccount';

export interface SettingsSearchEntry {
  /**
   * Translation key of the label the page draws for the setting. The page
   * marks that row with the same text in `data-search-label`, so a result
   * always lands on its row (a test renders every page and checks).
   */
  label: string;
  /** The row is hidden until the Advanced switch is on. */
  advanced?: true;
  /** The page draws the row only then. */
  when?: SettingsSearchCondition;
}

// The settings each page draws, as the search lists them. Only labels a page
// renders belong here: settings-search-anchors.test.tsx renders every page
// and fails for an entry without its row. A description is found next to
// the label (see descriptionKeyFor) and searched too.
export const tabSearchEntries: Record<Tab, SettingsSearchEntry[]> = {
  account: [
    { label: 'settings.account.name_label' },
    { label: 'settings.account.email.label' },
    { label: 'settings.account.auth_method_label' },
    { label: 'settings.account.server.label', advanced: true },
    { label: 'settings.account.sections.addresses' },
    { label: 'settings.identities.identities_count.label' },
    { label: 'settings.identities.sub_addressing.label' },
    { label: 'settings.email_behavior.sub_address_delimiter.label', advanced: true },
    { label: 'settings.account.accounts.title', when: 'multiAccount' },
  ],
  general: [
    { label: 'settings.language_region.title' },
    { label: 'settings.language_region.language.label' },
    { label: 'settings.language_region.date_format.label' },
    { label: 'settings.language_region.date_locale.label', advanced: true },
    { label: 'settings.language_region.time_format.label' },
    { label: 'settings.language_region.time_zone.label' },
    { label: 'settings.language_region.first_day.label' },
    { label: 'appLock.section_title' },
    { label: 'appLock.enable_label' },
    { label: 'protocol_handlers.title' },
    { label: 'protocol_handlers.mailto_label' },
    { label: 'protocol_handlers.webcal_label' },
    { label: 'protocol_handlers.protocol_open_mode_label', advanced: true },
    { label: 'tour.settings_section' },
    { label: 'tour.restart_title' },
    { label: 'tour.show_on_new_devices_title', advanced: true },
  ],
  notifications: [
    { label: 'settings.notifications.email.title' },
    { label: 'settings.notifications.email.enabled' },
    { label: 'settings.notifications.email.sound' },
    { label: 'settings.appearance.favicon_unread_badge.label' },
    { label: 'account_unread.badge_all_accounts.label', when: 'multiAccount' },
    { label: 'settings.notifications.calendar.title' },
    { label: 'settings.notifications.calendar.enabled' },
    { label: 'settings.notifications.sound_selection.title' },
    { label: 'settings.notifications.sound_selection.choose' },
    { label: 'settings.notifications.push.title' },
    { label: 'settings.notifications.push.relay_label', advanced: true },
    { label: 'settings.notifications.push.devices_title', advanced: true },
  ],
  appearance: [
    { label: 'settings.appearance.theme.label' },
    { label: 'settings.themes.title' },
    { label: 'settings.appearance.sections.text' },
    { label: 'settings.appearance.list_density.label' },
    { label: 'settings.appearance.sections.layout' },
    { label: 'settings.appearance.interface_layout.label' },
    { label: 'settings.email_behavior.mail_layout.label' },
    { label: 'settings.appearance.toolbar_position.label' },
    { label: 'settings.appearance.toolbar_labels.label' },
    { label: 'settings.appearance.sections.sidebar' },
    { label: 'settings.appearance.colorful_sidebar_icons.label' },
    { label: 'settings.appearance.show_folder_total_count.label' },
    { label: 'settings.appearance.sections.experimental', advanced: true },
    { label: 'settings.appearance.pro_interface.label', advanced: true },
    { label: 'settings.appearance.show_rail_account_list.label', when: 'multiAccount' },
  ],
  accessibility: [
    { label: 'settings.accessibility.presets.title' },
    { label: 'settings.accessibility.quick_button.label' },
    { label: 'settings.accessibility.sections.text' },
    { label: 'settings.accessibility.text_size.label' },
    { label: 'settings.accessibility.font.label' },
    { label: 'settings.accessibility.plain_text_font.label' },
    { label: 'settings.accessibility.line_spacing.label' },
    { label: 'settings.accessibility.letter_spacing.label' },
    { label: 'settings.accessibility.word_spacing.label' },
    { label: 'settings.accessibility.paragraph_spacing.label' },
    { label: 'settings.accessibility.reading_width.label' },
    { label: 'settings.accessibility.reading_mask.label' },
    { label: 'settings.accessibility.plain_language.label' },
    { label: 'settings.appearance.list_density.label' },
    { label: 'settings.appearance.toolbar_labels.label' },
    { label: 'settings.accessibility.sections.contrast' },
    { label: 'settings.accessibility.contrast.label' },
    { label: 'settings.accessibility.transparency.label' },
    { label: 'settings.accessibility.underline_links.label' },
    { label: 'settings.accessibility.color_names.label' },
    { label: 'settings.accessibility.cvd_palette.label' },
    { label: 'settings.email_behavior.always_light_mode.label' },
    { label: 'settings.accessibility.theme_link.label' },
    { label: 'settings.accessibility.sections.motion' },
    { label: 'settings.accessibility.reduce_motion.label' },
    { label: 'settings.accessibility.pause_images.label' },
    { label: 'settings.accessibility.sections.keyboard' },
    { label: 'settings.accessibility.single_key_shortcuts.label' },
    { label: 'settings.accessibility.shortcut_list.label' },
    { label: 'settings.accessibility.focus_ring.label' },
    { label: 'settings.accessibility.focus_always.label' },
    { label: 'settings.accessibility.sections.pointer' },
    { label: 'settings.accessibility.large_targets.label' },
    { label: 'settings.accessibility.large_cursor.label' },
    { label: 'settings.accessibility.open_on_hover.label' },
    { label: 'calendar.settings.hover_preview' },
    { label: 'settings.accessibility.row_action_button.label' },
    { label: 'settings.accessibility.native_scrollbars.label' },
    { label: 'settings.accessibility.row_actions_link.label' },
    { label: 'settings.accessibility.sections.mail' },
    { label: 'settings.accessibility.mail_view.label' },
    { label: 'settings.accessibility.mail_text_size.label' },
    { label: 'settings.accessibility.mail_min_font_size.label' },
    { label: 'settings.accessibility.mail_override.label' },
    { label: 'settings.accessibility.mail_fit_width.label' },
    { label: 'settings.accessibility.read_aloud_rate.label' },
    { label: 'settings.accessibility.compose_font.label' },
    { label: 'settings.accessibility.compose_size.label' },
    { label: 'settings.email_behavior.group_conversations.label' },
    { label: 'settings.email_behavior.show_preview.label' },
    { label: 'settings.email_behavior.mark_read.label' },
    { label: 'settings.email_behavior.return_to_list_after_action.label' },
    { label: 'settings.accessibility.sections.timing' },
    { label: 'settings.accessibility.toast_duration.label' },
    { label: 'settings.email_behavior.send_delay.label' },
    { label: 'settings.accessibility.confirm_send.label' },
    { label: 'settings.accessibility.confirm_delete.label' },
    { label: 'settings.accessibility.confirm_archive.label' },
    { label: 'settings.email_behavior.confirm_bulk_delete.label' },
    { label: 'settings.accessibility.send_warnings_link.label' },
    { label: 'settings.accessibility.sections.alerts' },
    { label: 'settings.accessibility.visual_alerts.label' },
    { label: 'settings.notifications.email.sound' },
    { label: 'settings.notifications.calendar.sound' },
    { label: 'settings.notifications.sound_selection.choose' },
    { label: 'settings.appearance.favicon_unread_badge.label' },
    { label: 'settings.accessibility.unread_counts.label' },
    { label: 'settings.accessibility.do_not_disturb.label' },
    { label: 'settings.accessibility.sections.screen_readers' },
    { label: 'settings.accessibility.announce_new_mail.label' },
    { label: 'settings.accessibility.announce_preview.label' },
    { label: 'settings.accessibility.simple_mode.label' },
    { label: 'settings.accessibility.reset.title' },
    { label: 'settings.accessibility.reset.label' },
  ],
  message_list: [
    { label: 'settings.email_behavior.group_conversations.label' },
    { label: 'settings.email_behavior.show_preview.label' },
    { label: 'settings.appearance.message_list_order.label' },
    { label: 'settings.appearance.message_list_order.scope.label' },
    { label: 'settings.appearance.tint_list_rows.label' },
    { label: 'settings.email_behavior.show_verification_codes.label' },
    { label: 'settings.message_list.sections.senders' },
    { label: 'settings.advanced.sender_favicons.label' },
    { label: 'settings.advanced.sender_favicons.refresh_label' },
    { label: 'settings.advanced.show_avatars_in_junk.label', advanced: true },
    { label: 'settings.message_list.sections.actions' },
    { label: 'settings.email_behavior.hover_actions.label' },
    { label: 'settings.message_list.sections.delete' },
    { label: 'settings.email_behavior.delete_action.label' },
    { label: 'settings.email_behavior.archive_mode.label' },
    { label: 'settings.email_behavior.confirm_bulk_delete.label' },
    { label: 'settings.email_behavior.permanently_delete_junk.label', advanced: true },
    { label: 'settings.message_list.sections.loading', advanced: true },
    { label: 'settings.email_behavior.emails_per_page.label', advanced: true },
    { label: 'settings.email_behavior.search_default_scope.label', advanced: true },
    { label: 'settings.email_behavior.clear_search_on_folder_change.label', advanced: true },
    { label: 'settings.email_behavior.swipe_right_action.label', when: 'touch' },
    { label: 'settings.email_behavior.swipe_left_action.label', when: 'touch' },
    { label: 'settings.email_behavior.inbox_type.label', when: 'mountainView' },
  ],
  reading: [
    { label: 'settings.email_behavior.mark_read.label' },
    { label: 'settings.email_behavior.return_to_list_after_action.label' },
    { label: 'settings.reading_page.sections.display' },
    { label: 'settings.email_behavior.message_spacing.label' },
    { label: 'settings.reading_page.plain_text_font_link.label' },
    { label: 'settings.email_behavior.always_light_mode.label' },
    { label: 'settings.reading_page.sections.images' },
    { label: 'settings.email_behavior.external_content.label' },
    { label: 'settings.email_behavior.trusted_senders.label' },
    { label: 'settings.email_behavior.trusted_senders.use_address_book_label' },
    { label: 'settings.reading_page.sections.attachments' },
    { label: 'settings.email_behavior.attachment_position.label' },
    { label: 'settings.email_behavior.attachment_click_action.label' },
    { label: 'settings.email_behavior.attachment_image_previews.label' },
    { label: 'settings.email_behavior.hide_inline_image_attachments.label' },
    { label: 'settings.downloads.title', advanced: true },
    { label: 'settings.downloads.email_template.label', advanced: true },
    { label: 'settings.downloads.attachment_template.label', advanced: true },
    { label: 'settings.downloads.bundle_template.label', advanced: true },
    { label: 'settings.downloads.spaces.label', advanced: true },
    { label: 'settings.downloads.lowercase.label', advanced: true },
    { label: 'settings.downloads.strip_diacritics.label', advanced: true },
    { label: 'settings.downloads.collapse_separators.label', advanced: true },
    { label: 'settings.downloads.after_export.label', advanced: true },
  ],
  composing: [
    { label: 'settings.email_behavior.plain_text_mode.label' },
    { label: 'settings.email_behavior.recipient_mentions.label' },
    { label: 'settings.email_behavior.mention_adds_recipient.label' },
    { label: 'settings.email_behavior.rtl_editing.label', advanced: true },
    { label: 'proofreading.settings.title' },
    { label: 'proofreading.settings.enable' },
    { label: 'proofreading.settings.writing_language' },
    { label: 'settings.composing_page.sections.replying' },
    { label: 'settings.email_behavior.quick_reply.label' },
    { label: 'settings.email_behavior.auto_select_reply_identity.label' },
    { label: 'settings.email_behavior.signature_position.label' },
    { label: 'settings.email_behavior.signature_new_mail.label' },
    { label: 'settings.email_behavior.signature_reply_forward.label' },
    { label: 'settings.email_behavior.signature_separator.label', advanced: true },
    { label: 'settings.composing_page.sections.sending' },
    { label: 'settings.email_behavior.send_delay.label' },
    { label: 'settings.email_behavior.attachment_reminder.label' },
    { label: 'settings.email_behavior.empty_subject_warning.label' },
    { label: 'settings.email_behavior.placeholder_warning.label' },
    { label: 'settings.composing_page.sections.receipts' },
    { label: 'settings.email_behavior.request_read_receipt.label' },
    { label: 'settings.email_behavior.read_receipt_response.label' },
    { label: 'settings.templates.title' },
    { label: 'settings.templates.export_import', advanced: true },
    { label: 'settings.email_behavior.signatures_link.label' },
  ],
  vacation: [
    { label: 'settings.vacation.date_range.start' },
    { label: 'settings.vacation.date_range.end' },
    { label: 'settings.vacation.auto_reply.title' },
    { label: 'settings.vacation.status.label' },
    { label: 'settings.vacation.message.subject_label' },
    { label: 'settings.vacation.message.html_label' },
    { label: 'settings.vacation.forward.title' },
    { label: 'settings.vacation.forward.enabled_label' },
  ],
  filters: [
    { label: 'settings.filters.title' },
    { label: 'settings.filters.add_rule' },
    { label: 'settings.filters.raw_editor' },
  ],
  organize: [
    { label: 'settings.folders.folder_list' },
    { label: 'settings.folders.standard_roles', advanced: true },
    { label: 'settings.folders.role_inbox', advanced: true },
    { label: 'settings.folders.role_drafts', advanced: true },
    { label: 'settings.folders.role_sent', advanced: true },
    { label: 'settings.folders.role_trash', advanced: true },
    { label: 'settings.folders.role_junk', advanced: true },
    { label: 'settings.folders.role_archive', advanced: true },
    { label: 'settings.keywords.title' },
    { label: 'settings.keywords.nesting.label' },
  ],
  security: [
    { label: 'settings.security.title' },
    { label: 'settings.security.totp.label' },
    { label: 'settings.security.sections.devices' },
    { label: 'settings.security.sections.encryption', advanced: true },
    { label: 'settings.security.password.title' },
    { label: 'settings.security.totp.section_title' },
    { label: 'settings.security.app_passwords.title' },
    { label: 'settings.security.api_keys.title', advanced: true },
    { label: 'settings.security.encryption.section_title', advanced: true },
    { label: 'settings.security.email_client.title' },
    { label: 'settings.security.link_device.title' },
  ],
  sharing: [
    { label: 'delegates.title' },
  ],
  recovery: [
    { label: 'recover_deleted.title' },
  ],
  calendar: [
    { label: 'calendar.settings.title' },
    { label: 'calendar.settings.default_view' },
    { label: 'calendar.settings.invitation_parsing' },
    { label: 'calendar.settings.show_time_in_month_view' },
    { label: 'calendar.settings.tinted_events' },
    { label: 'calendar.settings.month_timed_events' },
    { label: 'calendar.settings.show_week_numbers' },
    { label: 'calendar.settings.limit_hours' },
    { label: 'calendar.settings.visible_hours' },
    { label: 'calendar.settings.hide_non_working_days' },
    { label: 'calendar.settings.calendar_free_scroll' },
    { label: 'calendar.settings.hover_preview' },
    { label: 'calendar.settings.show_birthday_calendar' },
    { label: 'calendar.settings.enable_tasks' },
    { label: 'calendar.management.title' },
    { label: 'calendar.import.title' },
    { label: 'calendar.subscription.title' },
  ],
  contacts: [
    { label: 'settings.contacts.group_by_letter_label' },
    { label: 'settings.contacts.sort_by_last_name_label' },
    { label: 'settings.contacts.show_directory_label' },
    { label: 'settings.contacts.import_label' },
    { label: 'settings.contacts.export_label' },
    { label: 'settings.contacts.manage_title' },
    { label: 'settings.contacts.categories_title' },
  ],
  files: [
    { label: 'settings.files.display.title' },
    { label: 'settings.files.default_view.label' },
    { label: 'settings.files.default_sort.label' },
    { label: 'settings.files.sort_direction.label' },
    { label: 'settings.files.icons.title' },
    { label: 'settings.files.show_icons.label' },
    { label: 'settings.files.colored_icons.label' },
    { label: 'settings.files.show_thumbnails.label' },
    { label: 'settings.files.behavior.title', advanced: true },
    { label: 'settings.files.show_hidden.label', advanced: true },
  ],
  addons: [
    { label: 'settings.sidebar_apps.title' },
    { label: 'settings.sidebar_apps.keep_loaded', advanced: true },
  ],
  backup: [
    { label: 'settings.advanced.sections.backup' },
    { label: 'settings.advanced.export_settings.label' },
    { label: 'settings.advanced.import_settings.label' },
    { label: 'settings.advanced.sections.fix' },
    { label: 'settings.advanced.refresh_cache.label' },
    { label: 'settings.advanced.reset_settings.label' },
    { label: 'settings.advanced.debug_mode.label', advanced: true },
  ],
};

// Extra English keywords per tab so common search terms hit even when the
// translation doesn't contain the literal word.
/** Settings shown only while the admin has the Archive action on (#1257). */
export const ARCHIVE_ACTION_SEARCH_PATHS: ReadonlySet<string> = new Set(['settings.email_behavior.archive_mode.label']);

export const tabKeywords: Record<Tab, string> = {
  account: 'profile email user signin signout reorder rearrange drag dropdown switcher multi-account identities from address signature plus addressing unified mailbox shared group',
  general: 'language locale region timezone date time format mailto webcal links default app protocol handler tour onboarding lock pin passkey windows hello touch id',
  notifications: 'sound alert push badge favicon tab icon unread count background relay device',
  appearance: 'theme dark light font size accent color animation density custom theme css skin toolbar sidebar account switcher icons rail layout reading pane',
  accessibility: 'a11y accessible vision blind low vision screen reader contrast motion animation reduce zoom text size font dyslexia spacing keyboard shortcuts focus outline cursor pointer targets colour blind color sound visual alert hearing deaf simple plain language read aloud',
  message_list: 'inbox list preview thread conversation grouping sort order columns archive delete swipe hover favicon avatar tag color',
  reading: 'mark read attachment open monospace mono font plain text images remote content block sender privacy tracking dark light download filename template eml save export',
  composing: 'editor signature plain text reply forward draft compose template snippet quick reply mention undo send receipt attachment reminder',
  vacation: 'auto reply away out of office holiday responder',
  filters: 'sieve rules add create new block junk forward',
  organize: 'folders mailbox subscribe roles tags labels keywords colors nested',
  security: 'password 2fa two-factor passkey app password mfa api key token phone mobile app pair qr thunderbird outlook imap client encryption pgp smime',
  sharing: 'delegate delegation share access assistant permissions revoke folders calendars contacts colleague',
  recovery: 'recover restore undelete deleted trash emptied lost messages',
  calendar: 'event schedule appointment meeting timezone invitation ics tasks birthday working hours',
  contacts: 'address book contact',
  files: 'attachments cloud drive storage upload',
  addons: 'apps webview iframe plugins extensions addons sidebar',
  backup: 'export import storage quota privacy backup reset sync cache about version debug logs developer console diagnostic',
};

// Some settings texts name the app with {appName} (#1314). The index keeps
// them filled in, so the search matches the name people see and a result
// never carries the raw placeholder.
export function withAppName(node: unknown, appName: string): unknown {
  if (typeof node === 'string') return node.split('{appName}').join(appName);
  if (Array.isArray(node)) return node.map((item) => withAppName(item, appName));
  if (node && typeof node === 'object') {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, withAppName(value, appName)]));
  }
  return node;
}

export interface SubResult {
  label: string;
  description?: string;
  // For plugin setting fields: the id of the plugin whose card needs to be
  // expanded before the field becomes visible in the DOM.
  pluginId?: string;
  /** The row is hidden until the Advanced switch is on. */
  advanced?: boolean;
}

/**
 * The key of the text a page shows under a label: `x.label` and `x.title`
 * have `x.description`, `x_label` has `x_description`, and a flat `x` (the
 * calendar settings) has `x_desc`.
 */
export function descriptionKeyFor(label: string, messages: unknown): string | undefined {
  const candidates = [
    label.replace(/\.(label|title)$/, '.description'),
    label.replace(/_(label|title)$/, '_description'),
    `${label}_desc`,
    `${label}_description`,
  ].filter((key) => key !== label);
  return candidates.find((key) => typeof getByPath(messages, key) === 'string');
}

/**
 * The search results a page offers, in the language of `messages`:
 * each entry's label and description, with the app's name filled in.
 * `shown` leaves out entries the page doesn't draw right now.
 */
export function settingsSubResults(
  messages: unknown,
  tab: SettingsSearchTab,
  appName: string,
  shown: (entry: SettingsSearchEntry) => boolean = () => true,
): SubResult[] {
  const list: SubResult[] = [];
  for (const entry of tabSearchEntries[tab]) {
    if (!shown(entry)) continue;
    const label = getByPath(messages, entry.label);
    if (typeof label !== 'string') continue;
    const descriptionKey = descriptionKeyFor(entry.label, messages);
    const description = descriptionKey ? (getByPath(messages, descriptionKey) as string) : undefined;
    list.push({
      label: withAppName(label, appName) as string,
      ...(description ? { description: withAppName(description, appName) as string } : {}),
      ...(entry.advanced ? { advanced: true } : {}),
    });
  }
  return list;
}

/** Every word of the query is somewhere in the text, in any order. */
export function matchesAllWords(text: string, query: string): boolean {
  const haystack = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((word) => haystack.includes(word));
}

export function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split('.')) {
    if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return cur;
}
