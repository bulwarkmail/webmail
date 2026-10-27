// Settings search index helpers: which translation subtrees each settings tab
// renders, extra keywords per tab, and the walker that turns those subtrees
// into clickable sub-results. Kept free of React so it can be unit-tested.

export type SettingsSearchTab =
  | 'account'
  | 'general'
  | 'notifications'
  | 'appearance'
  | 'message_list'
  | 'reading'
  | 'composing'
  | 'vacation'
  | 'filters'
  | 'organize'
  | 'security'
  | 'calendar'
  | 'contacts'
  | 'files'
  | 'addons'
  | 'backup';

type Tab = SettingsSearchTab;

// Translation paths per tab. Tabs that share a namespace (email_behavior,
// appearance) explicitly list the subkeys they actually render so sub-results
// are attributed to the correct tab. Tabs with their own namespace just point
// at the namespace root.
export const tabSearchPaths: Record<Tab, string[]> = {
  account: [
    'settings.account.name_label',
    'settings.security.display_name',
    'settings.account.username_label',
    'settings.account.account_type_label',
    'settings.account.auth_method_label',
    'settings.account.email',
    'settings.account.server',
    'settings.account.storage',
    'settings.identities',
    'settings.email_behavior.sub_address_delimiter',
    'settings.account.accounts',
    'settings.account.backup',
    'settings.appearance.unified_mailbox',
    'settings.appearance.cross_unread',
    'settings.appearance.cross_starred',
    'settings.appearance.cross_all',
    'settings.appearance.all_mail',
    'settings.appearance.account_marker',
    'settings.appearance.show_shared_mail_accounts',
    'settings.account.shared_accounts',
  ],
  general: ['settings.language_region', 'protocol_handlers', 'tour.restart_title', 'tour.show_on_new_devices_title'],
  notifications: ['settings.notifications', 'settings.appearance.favicon_unread_badge'],
  appearance: [
    'settings.appearance.theme',
    'settings.themes',
    'settings.appearance.font_size',
    'settings.appearance.list_density',
    'settings.appearance.animations',
    'settings.appearance.interface_layout',
    'settings.email_behavior.mail_layout',
    'settings.appearance.toolbar_position',
    'settings.appearance.toolbar_labels',
    'settings.appearance.colorful_sidebar_icons',
    'settings.appearance.show_folder_total_count',
    'settings.appearance.hide_account_switcher',
    'settings.appearance.show_rail_account_list',
    'settings.appearance.pro_interface',
  ],
  message_list: [
    'settings.email_behavior.group_conversations',
    'settings.email_behavior.show_preview',
    'settings.email_behavior.list_columns',
    'settings.appearance.message_list_order',
    'settings.appearance.tint_list_rows',
    'settings.email_behavior.show_verification_codes',
    'settings.advanced.sender_favicons',
    'settings.advanced.show_avatars_in_junk',
    'settings.email_behavior.hover_actions',
    'settings.email_behavior.swipe_right_action',
    'settings.email_behavior.swipe_left_action',
    'settings.email_behavior.delete_action',
    'settings.email_behavior.archive_mode',
    'settings.email_behavior.confirm_bulk_delete',
    'settings.email_behavior.permanently_delete_junk',
    'settings.email_behavior.emails_per_page',
    'settings.email_behavior.clear_search_on_folder_change',
  ],
  reading: [
    'settings.email_behavior.mark_read',
    'settings.email_behavior.return_to_list_after_action',
    'settings.email_behavior.message_spacing',
    'settings.email_behavior.plain_text_font',
    'settings.email_behavior.always_light_mode',
    'settings.email_behavior.external_content',
    'settings.email_behavior.trusted_senders',
    'settings.email_behavior.attachment_position',
    'settings.email_behavior.attachment_click_action',
    'settings.email_behavior.attachment_image_previews',
    'settings.email_behavior.hide_inline_image_attachments',
    'settings.downloads',
  ],
  composing: [
    'settings.templates',
    'settings.email_behavior.signatures_link',
    'settings.email_behavior.attachment_reminder',
    'settings.email_behavior.quick_reply',
    'settings.email_behavior.auto_select_reply_identity',
    'settings.email_behavior.reply_identity_match',
    'settings.email_behavior.plain_text_mode',
    'settings.email_behavior.rtl_editing',
    'settings.email_behavior.default_mail_program',
    'settings.email_behavior.empty_subject_warning',
    'settings.email_behavior.send_delay',
    'settings.email_behavior.signature_position',
    'settings.email_behavior.signature_separator',
    'settings.email_behavior.request_read_receipt',
    'settings.email_behavior.read_receipt_response',
  ],
  vacation: ['settings.vacation'],
  filters: ['settings.filters'],
  organize: ['settings.folders', 'settings.keywords'],
  security: ['settings.security'],
  calendar: ['calendar.settings', 'calendar.management'],
  contacts: ['settings.contacts', 'contacts'],
  files: ['settings.files'],
  addons: ['settings.sidebar_apps', 'sidebar_apps', 'plugins.settings'],
  backup: ['settings.advanced'],
};

// Extra English keywords per tab so common search terms hit even when the
// translation doesn't contain the literal word.
/** Settings shown only while the admin has the Archive action on (#1257). */
export const archiveActionSearchPaths: ReadonlySet<string> = new Set(['settings.email_behavior.archive_mode']);

export const tabKeywords: Record<Tab, string> = {
  account: 'profile email user signin signout reorder rearrange drag dropdown switcher multi-account identities from address signature plus addressing unified mailbox shared group',
  general: 'language locale region timezone date time format mailto webcal links default app protocol handler tour onboarding',
  notifications: 'sound alert push badge favicon tab icon unread count background relay device',
  appearance: 'theme dark light font size accent color animation density custom theme css skin toolbar sidebar account switcher icons rail layout reading pane',
  message_list: 'inbox list preview thread conversation grouping sort order columns archive delete swipe hover favicon avatar tag color',
  reading: 'mark read attachment open monospace mono font plain text images remote content block sender privacy tracking dark light download filename template eml save export',
  composing: 'editor signature plain text reply forward draft compose template snippet quick reply mention undo send receipt attachment reminder',
  vacation: 'auto reply away out of office holiday responder',
  filters: 'sieve rules block junk forward',
  organize: 'folders mailbox subscribe roles tags labels keywords colors nested',
  security: 'password 2fa two-factor passkey app password mfa api key token phone mobile app pair qr thunderbird outlook imap client encryption pgp smime',
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

export function flattenStrings(node: unknown, sink: string[]): void {
  if (typeof node === 'string') {
    sink.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) flattenStrings(item, sink);
    return;
  }
  if (node && typeof node === 'object') {
    for (const value of Object.values(node)) flattenStrings(value, sink);
  }
}

export interface SubResult {
  label: string;
  description?: string;
  // For plugin setting fields: the id of the plugin whose card needs to be
  // expanded before the field becomes visible in the DOM.
  pluginId?: string;
}

// Walk a translation subtree and emit sub-results for renderable settings.
// Picks up:
//   - bare string leaves (when a tab path points directly at a flat label)
//   - objects with a `label` or `title` field (the standard pattern)
//   - flat `*_label` string keys at any object level (e.g. `name_label`)
//   - flat `foo` / `foo_desc` string pairs (the calendar.settings pattern)
export function collectSubResults(node: unknown, sink: SubResult[]): void {
  if (typeof node === 'string') {
    sink.push({ label: node });
    return;
  }
  if (!node || typeof node !== 'object' || Array.isArray(node)) return;
  const obj = node as Record<string, unknown>;
  const label = typeof obj.label === 'string' ? obj.label : (typeof obj.title === 'string' ? obj.title : undefined);
  if (label) {
    sink.push({
      label,
      description: typeof obj.description === 'string' ? obj.description : undefined,
    });
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string' || key === 'label' || key === 'title') continue;
    if (key.endsWith('_label')) {
      sink.push({ label: value });
      continue;
    }
    const desc = obj[`${key}_desc`];
    if (typeof desc === 'string') {
      sink.push({ label: value, description: desc });
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      collectSubResults(value, sink);
    }
  }
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
