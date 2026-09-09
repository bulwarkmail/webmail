// Settings search index helpers: which translation subtrees each settings tab
// renders, extra keywords per tab, and the walker that turns those subtrees
// into clickable sub-results. Kept free of React so it can be unit-tested.

export type SettingsSearchTab =
  | 'account'
  | 'language'
  | 'notifications'
  | 'appearance'
  | 'layout'
  | 'reading'
  | 'composing'
  | 'downloads'
  | 'identities'
  | 'vacation'
  | 'filters'
  | 'templates'
  | 'folders'
  | 'keywords'
  | 'security'
  | 'content_senders'
  | 'calendar'
  | 'contacts'
  | 'files'
  | 'protocol_handlers'
  | 'sidebar_apps'
  | 'about_data'
  | 'themes'
  | 'plugins'
  | 'debug';

type Tab = SettingsSearchTab;

// Translation paths per tab. Tabs that share a namespace (email_behavior,
// appearance) explicitly list the subkeys they actually render so sub-results
// are attributed to the correct tab. Tabs with their own namespace just point
// at the namespace root.
export const tabSearchPaths: Record<Tab, string[]> = {
  account: [
    'settings.account.name_label',
    'settings.account.username_label',
    'settings.account.account_type_label',
    'settings.account.auth_method_label',
    'settings.account.email',
    'settings.account.server',
    'settings.account.storage',
    'settings.account.accounts',
  ],
  language: ['settings.language_region'],
  notifications: ['settings.notifications'],
  appearance: [
    'settings.appearance.theme',
    'settings.appearance.font_size',
    'settings.appearance.list_density',
    'settings.appearance.animations',
    'settings.appearance.message_list_order',
    'settings.advanced.sender_favicons',
    'settings.advanced.show_avatars_in_junk',
  ],
  layout: [
    'settings.appearance.toolbar_position',
    'settings.appearance.toolbar_labels',
    'settings.appearance.hide_account_switcher',
    'settings.appearance.show_rail_account_list',
    'settings.appearance.unified_mailbox',
    'settings.appearance.cross_unread',
    'settings.appearance.cross_starred',
    'settings.appearance.cross_all',
    'settings.appearance.all_mail',
    'settings.appearance.colorful_sidebar_icons',
    'settings.appearance.tint_list_rows',
    'settings.appearance.show_folder_total_count',
    'settings.appearance.favicon_unread_badge',
    'settings.appearance.pro_interface',
    'settings.email_behavior.mail_layout',
  ],
  reading: [
    'settings.email_behavior.mark_read',
    'settings.email_behavior.message_spacing',
    'settings.email_behavior.archive_mode',
    'settings.email_behavior.delete_action',
    'settings.email_behavior.attachment_click_action',
    'settings.email_behavior.attachment_image_previews',
    'settings.email_behavior.attachment_position',
    'settings.email_behavior.disable_threading',
    'settings.email_behavior.emails_per_page',
    'settings.email_behavior.hide_inline_image_attachments',
    'settings.email_behavior.hover_actions',
    'settings.email_behavior.permanently_delete_junk',
    'settings.email_behavior.plain_text_font',
    'settings.email_behavior.show_preview',
    'settings.email_behavior.return_to_list_after_action',
    'settings.email_behavior.swipe_right_action',
    'settings.email_behavior.swipe_left_action',
    'settings.email_behavior.clear_search_on_folder_change',
  ],
  composing: [
    'settings.email_behavior.attachment_reminder',
    'settings.email_behavior.auto_select_reply_identity',
    'settings.email_behavior.plain_text_mode',
    'settings.email_behavior.rtl_editing',
    'settings.email_behavior.default_mail_program',
    'settings.email_behavior.empty_subject_warning',
    'settings.email_behavior.send_delay',
    'settings.email_behavior.signature_position',
    'settings.email_behavior.signature_separator',
    'settings.email_behavior.request_read_receipt',
    'settings.email_behavior.read_receipt_response',
    'settings.email_behavior.sub_address_delimiter',
  ],
  downloads: ['settings.downloads'],
  identities: ['settings.identities'],
  vacation: ['settings.vacation'],
  filters: ['settings.filters'],
  templates: ['settings.templates'],
  folders: ['settings.folders'],
  keywords: ['settings.keywords'],
  security: ['settings.security'],
  content_senders: [
    'settings.email_behavior.always_light_mode',
    'settings.email_behavior.external_content',
    'settings.email_behavior.trusted_senders',
  ],
  calendar: ['calendar.settings', 'calendar.management'],
  contacts: ['settings.contacts', 'contacts'],
  files: ['settings.files'],
  protocol_handlers: ['protocol_handlers'],
  sidebar_apps: ['settings.sidebar_apps', 'sidebar_apps'],
  about_data: ['settings.advanced'],
  themes: [],
  plugins: [],
  debug: ['settings.advanced'],
};

// Extra English keywords per tab so common search terms hit even when the
// translation doesn't contain the literal word.
export const tabKeywords: Record<Tab, string> = {
  account: 'profile email password user signin signout reorder rearrange drag dropdown switcher multi-account',
  language: 'locale region timezone date time format',
  notifications: 'sound alert push badge',
  appearance: 'theme dark light font size accent color animation density',
  layout: 'toolbar sidebar account switcher unified mailbox icons rail',
  reading: 'mark read preview thread conversation archive delete attachment open monospace mono font plain text',
  composing: 'editor signature plain text reply forward draft compose',
  downloads: 'download filename template eml attachment save export',
  identities: 'from address signature email',
  vacation: 'auto reply away out of office holiday responder',
  filters: 'sieve rules block junk forward',
  templates: 'snippet quick reply',
  folders: 'mailbox subscribe',
  keywords: 'tags labels colors',
  security: 'password 2fa two-factor passkey app password mfa',
  content_senders: 'block sender remote images privacy tracking',
  calendar: 'event schedule appointment meeting timezone',
  contacts: 'address book contact',
  files: 'attachments cloud drive storage upload',
  protocol_handlers: 'mailto webcal links default app protocol handler',
  sidebar_apps: 'apps webview iframe',
  about_data: 'export import storage quota privacy backup',
  themes: 'custom theme css skin appearance',
  plugins: 'extensions addons',
  debug: 'logs developer console diagnostic',
};

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
