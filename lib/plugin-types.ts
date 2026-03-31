// Plugin & Theme system types

// ─── Common ──────────────────────────────────────────────────

export type Disposable = { dispose: () => void };
export type MaybePromise<T> = T | Promise<T>;

export type PluginType = 'ui-extension' | 'sidebar-app' | 'hook' | 'theme';
export type PluginStatus = 'installed' | 'enabled' | 'running' | 'disabled' | 'error';
export type ThemeVariant = 'light' | 'dark';

// ─── Manifests ───────────────────────────────────────────────

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: 'theme';
  preview?: string;
  variants: ThemeVariant[];
  minAppVersion?: string;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: Exclude<PluginType, 'theme'>;
  permissions: string[];
  entrypoint: string;
  minAppVersion?: string;
  settingsSchema?: Record<string, SettingFieldSchema>;
}

export interface SettingFieldSchema {
  type: 'boolean' | 'string' | 'number' | 'select';
  label: string;
  description?: string;
  default: unknown;
  options?: string[];
  min?: number;
  max?: number;
}

// ─── Installed Items ─────────────────────────────────────────

export interface InstalledTheme {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  preview?: string;       // data: URI or blob URL
  css: string;            // raw CSS text
  variants: ThemeVariant[];
  enabled: boolean;
  builtIn: boolean;
  managed?: boolean;
  forceEnabled?: boolean;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: Exclude<PluginType, 'theme'>;
  permissions: string[];
  entrypoint: string;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  // True when plugin was delivered from server-side admin registry.
  managed?: boolean;
  // True when plugin is admin-enforced and cannot be disabled locally.
  forceEnabled?: boolean;
  settingsSchema?: Record<string, SettingFieldSchema>;
  settings: Record<string, unknown>;
}

// ─── UI Slots ────────────────────────────────────────────────

export type SlotName =
  | 'toolbar-actions'
  | 'email-banner'
  | 'email-footer'
  | 'composer-toolbar'
  | 'sidebar-widget'
  | 'email-detail-sidebar'
  | 'settings-section'
  | 'context-menu-email'
  | 'navigation-rail-bottom'
  | 'calendar-event-actions'
  | 'admin-plugin-page';

export interface SlotRegistration {
  pluginId: string;
  component: React.ComponentType<Record<string, unknown>>;
  order: number;
}

// ─── Plugin API Types ────────────────────────────────────────

export interface ToolbarAction {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
  order?: number;
}

export interface BannerFactory {
  shouldShow: (email: EmailReadView) => boolean;
  render: React.ComponentType<{ email: EmailReadView }>;
}

export interface SettingsSection {
  id: string;
  label: string;
  icon?: string;
  render: React.ComponentType;
}

export interface ComposerAction {
  id: string;
  label: string;
  icon?: string;
  onClick: () => void;
  order?: number;
}

export interface SidebarWidget {
  id: string;
  label: string;
  render: React.ComponentType;
  order?: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  onClick: (emailIds: string[]) => void;
  order?: number;
}

export interface AdminPageSection {
  id: string;
  label: string;
  icon?: string;
  render: React.ComponentType;
}

export interface CalendarEventAction {
  id: string;
  label: string;
  icon?: string;
  onClick: (eventData: CalendarEventFormView, helpers: { setVirtualLocation: (url: string) => void }) => void;
  order?: number;
}

export interface CalendarEventFormView {
  title: string;
  description: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string;
  virtualLocation: string;
  calendarId: string;
}

export interface KeyboardShortcut {
  id: string;
  keys: string;
  label: string;
  category: string;
  handler: () => void;
}

// ─── Read-Only View Types ────────────────────────────────────
// Projected views exposed to plugins — no direct store references

export interface EmailReadView {
  id: string;
  threadId: string;
  mailboxIds: string[];
  from: { name: string; email: string }[];
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  subject: string;
  receivedAt: string;
  isRead: boolean;
  isFlagged: boolean;
  hasAttachment: boolean;
  preview: string;
  keywords: string[];
}

export interface DraftView {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  htmlBody: string;
  textBody: string;
  identityId: string;
  inReplyTo?: string;
  attachments: { name: string; type: string; size: number }[];
}

export interface MailboxView {
  id: string;
  name: string;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
  parentId: string | null;
}

export interface CalendarEventView {
  id: string;
  calendarId: string;
  title: string;
  description: string;
  start: string;
  end: string;
  isAllDay: boolean;
  location: string;
  status: string;
  recurrenceRule?: string;
}

export interface CalendarView {
  id: string;
  name: string;
  color: string;
  isVisible: boolean;
  isDefault: boolean;
}

export interface ContactView {
  id: string;
  addressBookId: string;
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  company: string;
  notes: string;
}

export interface AddressBookView {
  id: string;
  name: string;
  isDefault: boolean;
}

export interface ContactGroupView {
  id: string;
  name: string;
  memberCount: number;
}

export interface FileResourceView {
  id: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  mimeType: string;
  path: string;
  modified: string;
}

export interface IdentityView {
  id: string;
  name: string;
  email: string;
  replyTo: string | null;
  bcc: string | null;
  htmlSignature: string;
  textSignature: string;
}

export interface TaskView {
  id: string;
  title: string;
  description: string;
  isComplete: boolean;
  dueDate: string | null;
  priority: string;
  calendarId: string;
}

export interface TemplateView {
  id: string;
  name: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface FilterRuleView {
  id: string;
  name: string;
  isActive: boolean;
  conditions: unknown[];
  actions: unknown[];
}

export interface KeywordView {
  id: string;
  name: string;
  color: string;
}

export interface QuotaView {
  used: number;
  total: number;
  percentUsed: number;
}

export interface CalendarAlertView {
  id: string;
  eventId: string;
  eventTitle: string;
  triggerTime: string;
}

export interface SearchFilters {
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  after?: string;
  before?: string;
  inMailbox?: string;
}

export interface NewEmailNotification {
  emailId: string;
  from: { name: string; email: string };
  subject: string;
  preview: string;
}

export interface VacationView {
  isEnabled: boolean;
  subject: string;
  htmlBody: string;
  textBody: string;
  fromDate: string | null;
  toDate: string | null;
}

export interface KeyboardEventView {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface AppConfigView {
  appName: string;
  demoMode: boolean;
  stalwartFeaturesEnabled: boolean;
  oauthEnabled: boolean;
}

export interface FileInfo {
  name: string;
  size: number;
  type: string;
}

export interface ComposerContext {
  mode: 'new' | 'reply' | 'reply-all' | 'forward';
  inReplyToId?: string;
  originalSubject?: string;
}

// ─── Permission Reference ────────────────────────────────────

export const ALL_PERMISSIONS = [
  'email:read', 'email:write', 'email:send',
  'calendar:read', 'calendar:write',
  'contacts:read', 'contacts:write',
  'files:read', 'files:write',
  'identity:read', 'identity:write',
  'filters:read', 'filters:write',
  'tasks:read', 'tasks:write',
  'templates:read', 'templates:write',
  'smime:read',
  'vacation:read', 'vacation:write',
  'settings:read', 'settings:write',
  'security:read',
  'auth:observe',
  'ui:observe', 'ui:toolbar', 'ui:email-banner', 'ui:email-footer',
  'ui:composer-toolbar', 'ui:sidebar-widget', 'ui:settings-section',
  'ui:context-menu', 'ui:navigation-rail', 'ui:keyboard',
  'ui:calendar-action', 'ui:admin-page',
  'admin:config',
  'app:lifecycle',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Permissions always granted regardless of manifest */
export const IMPLICIT_PERMISSIONS: Permission[] = ['ui:observe', 'app:lifecycle'];

// ─── Validation ──────────────────────────────────────────────

export const MAX_PLUGIN_SIZE = 5 * 1024 * 1024; // 5 MB
export const MAX_THEME_SIZE = 1 * 1024 * 1024;  // 1 MB

export const ALLOWED_PLUGIN_FILES = new Set([
  '.js', '.mjs', '.css', '.json', '.png', '.svg', '.woff2', '.jpg', '.jpeg', '.webp',
]);

export const DISALLOWED_CSS_PATTERNS = [
  /@import\b/i,
  /url\s*\(\s*['"]?https?:/i,
  /url\s*\(\s*['"]?data:/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /-moz-binding/i,
  /behavior\s*:/i,
];
