// Plugin & Theme system types

// ─── Common ──────────────────────────────────────────────────

export type Disposable = { dispose: () => void };
export type MaybePromise<T> = T | Promise<T>;

export type PluginType = 'ui-extension' | 'sidebar-app' | 'hook' | 'theme';
export type PluginStatus = 'installed' | 'enabled' | 'running' | 'disabled' | 'error';
/**
 * Execution tier a plugin runs in.
 * - 'untrusted' (default): null-origin sandbox iframe. No `crypto.subtle`,
 *   IndexedDB, or localStorage in-frame; all capabilities go through the host
 *   RPC. This is the only tier most plugins ever need.
 * - 'privileged': same-origin sandbox iframe (full WebCrypto + IndexedDB) so a
 *   plugin can bundle its own crypto libs (e.g. pkijs for S/MIME, openpgp for
 *   PGP). Because same-origin == full host access, entering this tier is gated
 *   by a signed bundle + admin approval + high-risk consent — see
 *   `lib/plugin-sandbox/tier.ts` `resolvePluginTier`.
 */
export type PluginTier = 'untrusted' | 'privileged';
export type ThemeVariant = 'light' | 'dark';

// ─── Manifests ───────────────────────────────────────────────

/**
 * Advanced theme fields ("Theme API v2"). All optional and additive - a
 * legacy theme that ships only `:root`/`.dark` CSS continues to work.
 *
 * When `apiVersion >= 2` (or any of `tokens`/`extends`/`derive`/`density`/
 * `radii`/`typography` is present), the theme compiler runs at install time
 * and produces a single CSS string from the structured fields, optionally
 * concatenated with a hand-written `theme.css` for fine-grained overrides.
 */
export interface ThemeTokenSet {
  /** Tokens applied regardless of variant (emitted into `:root`). */
  common?: Record<string, string>;
  /** Tokens applied in light mode (emitted into `:root`). */
  light?: Record<string, string>;
  /** Tokens applied in dark mode (emitted into `.dark`). */
  dark?: Record<string, string>;
}

export type ThemeDensity = 'compact' | 'normal' | 'touch';

export interface ThemeRadii {
  sm?: string;
  md?: string;
  lg?: string;
  xl?: string;
  full?: string;
}

export interface ThemeTypography {
  fontSans?: string;
  fontMono?: string;
  fontDisplay?: string;
  baseFontSize?: string;
}

export interface ThemeManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: 'theme';
  /** @deprecated kept as alias for `banner` so existing themes still work. */
  preview?: string;
  /**
   * Path inside the source repo (relative to manifest.json) to a square
   * brand icon shown in marketplace cards and the host's theme picker.
   */
  icon?: string;
  /**
   * Path to a wide promo image shown as the hero on the theme detail
   * page. PNG/JPG/WebP, ≤512 KB.
   */
  banner?: string;
  /**
   * Up to 6 screenshot paths shown in the gallery on the detail page.
   * Themes typically use this to show light + dark variants.
   */
  screenshots?: string[];
  variants: ThemeVariant[];
  minAppVersion?: string;

  // ─── Advanced (Theme API v2) ─────────────────────────────────
  /** Theme API version. Defaults to 1 (raw-CSS only). */
  apiVersion?: 1 | 2;
  /** Inherit tokens/CSS from another installed (or built-in) theme by id. */
  extends?: string;
  /** Structured colour tokens - compiled into CSS at install time. */
  tokens?: ThemeTokenSet;
  /** When true, missing standard tokens are derived (e.g. *-foreground from contrast). */
  derive?: boolean;
  /** Default UI density preset (compact / normal / touch). */
  density?: ThemeDensity;
  /** Border-radius scale, emitted as `--radius-*` vars. */
  radii?: ThemeRadii;
  /** Font stacks + base size, emitted as `--font-*` vars. */
  typography?: ThemeTypography;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: Exclude<PluginType, 'theme'>;
  /**
   * Execution tier the plugin requests. Defaults to 'untrusted' when omitted.
   * Declaring 'privileged' opts into the same-origin tier and requires the
   * `crypto:full` permission, a signed bundle, and admin approval (enforced by
   * `resolvePluginTier`). Most plugins should omit this.
   */
  tier?: PluginTier;
  permissions: string[];
  entrypoint: string;
  minAppVersion?: string;
  settingsSchema?: Record<string, SettingFieldSchema>;
  /**
   * Bundled translations shipped inside the plugin ZIP.
   * Keyed by BCP-47 locale tag ("en", "de", "fr-CA", …).
   * The loader auto-registers these before calling activate(),
   * so plugins can use api.i18n.t() without calling addTranslations() first.
   */
  locales?: Record<string, Record<string, string>>;
  /**
   * External origins this plugin may embed in iframes (e.g. for YouTube,
   * Vimeo, Jitsi). Each entry is a single CSP origin like
   *   "https://www.youtube-nocookie.com"
   *   "https://*.example.com:8443"
   * Validated at install time and merged into the host CSP `frame-src`.
   */
  frameOrigins?: string[];
  /**
   * External HTTPS origins this plugin may make `api.http.fetch()` requests
   * to. Same syntax as `frameOrigins`. Validated at install time. Each
   * `api.http.fetch` call's URL must resolve to one of these origins (exact
   * host or a `*.host` wildcard match).
   *
   * Use for plugins that talk directly to a third-party service (e.g.
   * Nextcloud, Slack) instead of going through a same-origin /api/* route.
   * The remote host must serve CORS headers permitting the webmail origin.
   */
  httpOrigins?: string[];
  /**
   * Same-origin `/api/*` paths this plugin may target via `api.http.post()`.
   * Each entry is a path prefix; a call to `api.http.post('/api/X', ...)` is
   * accepted iff `'/api/X'` exactly equals an entry OR an entry ends in
   * `/` and `'/api/X'` starts with it. With no entry (or an empty array),
   * the plugin may not call `api.http.post` even with the `http:post`
   * permission. Validated at install time.
   */
  apiPostPaths?: string[];

  // ─── Marketplace media (NOT shipped in the runtime zip) ──────
  /**
   * Path inside the source repo (relative to manifest.json) to a square
   * brand icon. PNG/SVG/WebP, ≤256 KB, 128×128 or larger recommended.
   * The extension directory ingests this from git and serves it on
   * marketplace cards and the host's plugin admin UI.
   */
  icon?: string;
  /**
   * Path to a wide promo image (16:9 recommended), shown as the hero on
   * the extension detail page. PNG/JPG/WebP, ≤512 KB.
   */
  banner?: string;
  /**
   * Up to 6 screenshot paths shown in the gallery on the detail page.
   * Each ≤512 KB; total ≤2 MB. Order is preserved.
   */
  screenshots?: string[];
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
  css: string;            // compiled CSS text - what gets injected
  /**
   * Optional "skin" CSS shipped by Theme API v2 themes that need to restyle
   * actual UI components (toolbars, lists, buttons, etc.) - not just colour
   * tokens. Injected into a separate `<style>` tag so it can be stripped
   * cleanly when the theme is deactivated. Stored in IndexedDB with the same
   * lifecycle as `css` to keep localStorage small.
   */
  skin?: string;
  variants: ThemeVariant[];
  enabled: boolean;
  builtIn: boolean;
  managed?: boolean;
  forceEnabled?: boolean;

  // ─── Advanced (Theme API v2) ─ carried over from the manifest ─
  apiVersion?: 1 | 2;
  extends?: string;
  tokens?: ThemeTokenSet;
  derive?: boolean;
  density?: ThemeDensity;
  radii?: ThemeRadii;
  typography?: ThemeTypography;
}

export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: Exclude<PluginType, 'theme'>;
  /** Execution tier carried over from the manifest at install time. Defaults
   * to 'untrusted'. See `PluginTier` and `resolvePluginTier`. */
  tier?: PluginTier;
  permissions: string[];
  entrypoint: string;
  enabled: boolean;
  status: PluginStatus;
  error?: string;
  // True when plugin was delivered from server-side admin registry.
  managed?: boolean;
  // True when plugin is admin-enforced and cannot be disabled locally.
  forceEnabled?: boolean;
  // True when plugin has been approved by an admin. Unapproved plugins cannot be enabled.
  adminApproved?: boolean;
  settingsSchema?: Record<string, SettingFieldSchema>;
  settings: Record<string, unknown>;
  /** Bundled translations, carried over from the manifest on install. */
  locales?: Record<string, Record<string, string>>;
  /**
   * Content hash of the installed bundle, mirrored from the server. Used to
   * detect re-uploads of the same version so clients re-download the JS.
   */
  bundleHash?: string;
  /**
   * Validated allowlist of external HTTPS origins this plugin may target via
   * `api.http.fetch()`. Carried over from the manifest at install time.
   */
  httpOrigins?: string[];
  /**
   * Validated allowlist of same-origin `/api/*` paths this plugin may target
   * via `api.http.post()`. Carried over from the manifest at install time.
   */
  apiPostPaths?: string[];
  /**
   * Permissions the user has explicitly granted. Populated by the in-app
   * consent dialog the first time the plugin is enabled. The host API gate
   * checks this set in addition to `permissions`, so an unapproved permission
   * cannot be exercised even if it appears in the manifest. Managed plugins
   * skip the consent prompt (admin pre-approval).
   */
  grantedPermissions?: string[];
}

// ─── UI Slots ────────────────────────────────────────────────

export type SlotName =
  | 'toolbar-actions'
  | 'app-top-banner'
  | 'email-banner'
  | 'email-footer'
  | 'composer-toolbar'
  | 'composer-sidebar'
  | 'composer-sidebar-right'
  | 'sidebar-widget'
  | 'email-detail-sidebar'
  | 'email-details-section'
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
  /**
   * For composer sidebars, choose which side of the New Message dialog the
   * panel renders on. Defaults to `'left'` for backwards compatibility.
   * Ignored by other sidebar slots.
   */
  side?: 'left' | 'right';
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
// Projected views exposed to plugins - no direct store references

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
  /** Full plain-text body of the message (HTML-only bodies are stripped to
   *  text). Empty string when the host hasn't loaded the body. Same
   *  `email:read` sensitivity as the rest of this view. */
  text: string;
  /**
   * Raw parsed header map (header name → value, or values when a header
   * appears more than once), exactly as JMAP returned it. Absent until the
   * host has loaded the message's headers. Same `email:read` sensitivity as
   * the rest of this view.
   */
  headers?: Record<string, string | string[]>;
  /**
   * Full, human-readable message source — headers, metadata and body — the
   * same text the "View source" dialog shows. Empty string when the body
   * hasn't been fetched. Gated by `email:read` like the rest of this view.
   */
  source: string;
  /**
   * Parsed Authentication-Results header (SPF, DKIM, DMARC, reverse-DNS).
   * Absent on stores that didn't parse the header (e.g. bodies not yet
   * fetched). Mirrors the structured shape exposed by the host.
   */
  auth?: {
    spf?: { result: 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror'; domain?: string };
    dkim?: { result: 'pass' | 'fail' | 'policy' | 'neutral' | 'temperror' | 'permerror'; domain?: string; selector?: string };
    dmarc?: { result: 'pass' | 'fail' | 'none'; policy?: 'reject' | 'quarantine' | 'none'; domain?: string };
    iprev?: { result: 'pass' | 'fail'; ip?: string };
  };
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

// ─── New hook context types ──────────────────────────────────

/**
 * Passed to onBeforeCompose handlers.
 * Handlers may mutate the object in place to pre-fill fields; returning false cancels the compose.
 */
export interface ComposeOptions {
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  mode: 'new' | 'reply' | 'reply-all' | 'forward';
}

/**
 * A small visual indicator injected into an email list row via onEmailListItemRender.
 */
export interface EmailListBadge {
  /** Stable unique key within the plugin - used as React key */
  key: string;
  /** Short label text displayed in the badge */
  label: string;
  /** CSS color value for the badge background, e.g. "#e74c3c" or "var(--color-warning)" */
  color?: string;
  /** Tooltip / aria-label */
  title?: string;
}

/**
 * Passed to onMailtoIntercept handlers.
 * Return false to prevent the browser from opening the system mail client.
 */
export interface MailtoContext {
  /** The raw href, e.g. "mailto:alice@example.com?subject=Hello" */
  href: string;
  /** Parsed list of recipient addresses */
  to: string[];
  subject?: string;
  body?: string;
}

/**
 * Passed to onTransformOutgoingEmail handlers as a transform value.
 * Handlers receive the email about to be sent and return a (possibly mutated)
 * copy. Use to inject signatures, rewrite links, strip tracking pixels from
 * forwards, encrypt the body, etc. Return undefined to pass through unchanged.
 */
export interface OutgoingEmail {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  htmlBody: string;
  textBody: string;
  identityId: string;
  /** Sender email derived from the active identity (incl. sub-address tag, when set) */
  fromEmail?: string;
  attachments: { name: string; type: string; size: number }[];
  /** Original message id when this is a reply or forward */
  inReplyTo?: string;
  /** Free-form custom headers added by the composer or earlier handlers */
  headers?: Record<string, string>;
}
/**
 * Passed to onBeforeDraftAutoSave handlers as a transform value.
 */
export interface AlmostSavedDraft{
   to: string[],
    subject: string,
    body: string,
    cc?: string[],
    bcc?: string[],
    identityId?: string,
    fromEmail?: string,
    draftId?: string,
    attachments?: Array<{ blobId: string; name: string; type: string; size: number; disposition?: 'attachment' | 'inline'; cid?: string }>,
    fromName?: string,
    htmlBody?: string
}

/**
 * Passed to onBeforeReply / onBeforeReplyAll / onBeforeForward intercept hooks.
 * Return false to cancel the operation before the composer opens.
 */
export interface ReplyContext {
  originalEmailId: string;
  originalEmail: EmailReadView;
  mode: 'reply' | 'reply-all' | 'forward';
}

/**
 * Second argument to onBuildQuoteHeader transform handlers. Describes the
 * original message and how the host plans to render the quote header so
 * plugins can produce a replacement block (e.g. an Outlook-style
 * From/Sent/To/Cc/Subject section).
 */
export interface QuoteHeaderContext {
  mode: 'reply' | 'replyAll' | 'forward';
  /** Recipients of the new outgoing message (already resolved by the host). */
  newTo: string[];
  newCc: string[];
  /** Original message metadata. */
  from: { name?: string; email: string } | null;
  to: { name?: string; email: string }[];
  cc: { name?: string; email: string }[];
  subject: string;
  /** Pre-formatted date string the host already produced (locale-aware). */
  date: string;
  /** Raw ISO datetime, in case the plugin wants to reformat. */
  receivedAt?: string;
  /** Active UI locale (BCP-47), useful for Intl.DateTimeFormat in plugins. */
  locale: string;
}

/**
 * Initial value for the onBuildQuoteHeader transform hook. Plugins return a
 * replacement; returning undefined falls through to the next handler or the
 * default. The composer splices `html` into HTML drafts and `text` into
 * plain-text drafts.
 *
 * For HTML, returning a header that includes its own surrounding wrapper
 * (`<div>...</div>`) is fine; the composer does not add extra wrappers.
 * For text, the host appends the quoted body after the header.
 */
export interface QuoteHeader {
  html: string;
  text: string;
  /**
   * When false, the composer skips its default blockquote wrapping around the
   * quoted body (HTML mode only). Use this for the Outlook style where the
   * quoted message is intended to follow the header without indentation.
   * Defaults to true (preserve the existing blockquote wrapping).
   */
  wrapInBlockquote?: boolean;
}

/**
 * Describes an attachment crossing an attachment hook (upload, download, preview).
 */
export interface AttachmentInfo {
  name: string;
  type: string;
  size: number;
  /** JMAP blob id, when known (download / preview / after-upload) */
  blobId?: string;
  /** The email this attachment belongs to (download / preview) */
  emailId?: string;
}

/**
 * Initial value passed to the onAttachmentPreview transform hook. A handler
 * may return a different `previewUrl` (e.g. a proxied/sanitised URL) or a
 * React component descriptor identified by `customRenderer`. Return undefined
 * to pass through.
 */
export interface AttachmentPreview {
  previewUrl?: string;
  /** Optional plugin-supplied renderer key. The host resolves the renderer. */
  customRenderer?: string;
}

/**
 * Passed to onBeforeExternalLink intercept handlers when the user clicks a
 * link that would navigate away from the app (typically inside an email body).
 * Return false to cancel the navigation. Mutate `href` to rewrite it.
 */
export interface ExternalLinkContext {
  href: string;
  /** Anchor target ('_blank', '_self', etc.) when set */
  target?: string;
  /** Email currently in view, when the click came from an email body */
  emailId?: string;
}

/**
 * Passed to onTextSelectionChange observer when the user selects text inside
 * the app. Source identifies which surface produced the selection so plugins
 * can scope themselves (e.g. translate-on-select only inside emails).
 */
export interface SelectionContext {
  text: string;
  source: 'email-body' | 'composer' | 'task-detail' | 'event-detail' | 'other';
  emailId?: string;
}

/**
 * Returned by onCheckEventConflicts transform handlers. The form UI renders
 * each warning as an inline notice next to the event time fields.
 */
export interface ConflictWarning {
  /** Stable unique key per warning, used as React key */
  key: string;
  /** Short message - e.g. "Conflicts with: Team Standup" */
  message: string;
  severity?: 'info' | 'warning' | 'error';
}

/**
 * Returned by onProvideSearchResults transform handlers. Plugins extend the
 * initial array with their own results (CRM hits, Slack messages, etc.).
 * The host renders these in a grouped section below native email results.
 */
export interface ExternalSearchResult {
  /** Stable unique key */
  key: string;
  title: string;
  snippet: string;
  /** Plugin-handled action when the result row is clicked */
  onClick: () => void;
  /** Optional source label, e.g. "Slack", "Notion" */
  source?: string;
}

/**
 * Returned by onProvideRecipientSuggestions transform handlers. Lets plugins
 * contribute non-contact suggestions (Slack handles, GitHub usernames, etc.)
 * to the recipient autocomplete in the composer.
 */
export interface RecipientSuggestion {
  name: string;
  email: string;
  /** Optional source label rendered as a small tag */
  source?: string;
  avatarUrl?: string;
  /**
   * Present when the suggestion is a contact group (empty email). Selecting
   * it inserts a single group chip that expands into the members on send.
   */
  group?: { id: string; memberCount: number };
}

/**
 * Passed to router hooks (onNavigate, onRouteEnter, onRouteLeave).
 * Paths are app-internal, e.g. "/mail/inbox", "/calendar".
 */
export interface RouteContext {
  path: string;
  /** Previous path (only on onNavigate) */
  from?: string;
}

// ─── Plugin i18n API ─────────────────────────────────────────

/**
 * Localisation API exposed as `api.i18n` inside every plugin.
 *
 * Plugins ship their own translation tables; the app locale is tracked
 * automatically so `t()` always returns the right string without any
 * extra setup from the plugin side.
 */
export interface PluginI18n {
  /**
   * Register translations for one locale.
   * Multiple calls for the same locale are merged (last-write-wins per key).
   *
   * @param locale  BCP-47 tag, e.g. "en", "de", "fr-CA"
   * @param strings Key → translated string map. Use {paramName} for interpolation.
   *
   * @example
   * api.i18n.addTranslations('en', { 'banner.title': 'Tracking blocked' });
   * api.i18n.addTranslations('de', { 'banner.title': 'Tracking blockiert' });
   */
  addTranslations(locale: string, strings: Record<string, string>): void;

  /**
   * Return the translated string for `key` using the current app locale,
   * with optional {param} interpolation.
   *
   * Falls back: exact locale → language prefix → "en" → raw key.
   *
   * @example
   * api.i18n.t('banner.title')
   * api.i18n.t('items_found', { count: 3 })  // 'Found {count} items' → 'Found 3 items'
   */
  t(key: string, params?: Record<string, string | number>): string;

  /** The current app locale string (e.g. "en", "de", "fr") */
  getLocale(): string;
}

// ─── Permission Reference ────────────────────────────────────

export const ALL_PERMISSIONS = [
  'email:read', 'email:write', 'email:send',
  // ─── Privileged-tier capabilities (require tier: 'privileged') ───
  // Umbrella high-risk permission gating same-origin crypto execution. A
  // plugin holding this runs with full cryptographic access and can read
  // message bodies and private keys; only granted to a signed, admin-approved
  // privileged bundle after explicit high-risk consent.
  'crypto:full',
  // Submit a fully-formed raw RFC822 message via JMAP (used after a plugin
  // signs/encrypts an outgoing message itself).
  'email:raw-send',
  // Fetch a message blob's raw bytes by blobId (for decrypt/verify).
  'email:blob-read',
  // Upload a file to server (for encrypt).
  'email:blob-write',
  // Replace the rendered body of an opened email (render-takeover).
  'email:render-takeover',
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
  'http:post', 'http:fetch',
  'ui:observe', 'ui:toolbar', 'ui:app-top-banner', 'ui:email-banner', 'ui:email-footer',
  'ui:email-details',
  'ui:download-file',
  'ui:composer-toolbar', 'ui:composer-sidebar',
  'ui:sidebar-widget', 'ui:settings-section',
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
export const MAX_THEME_SIZE = 2 * 1024 * 1024;  // 2 MB (was 1 MB; v2 themes may ship a skin.css)
/**
 * Maximum size of an individual `skin.css` payload after extraction.
 * Skins are component-level CSS, not images - anything bigger than this is
 * almost certainly bundling assets the validator will refuse anyway.
 */
export const MAX_THEME_SKIN_BYTES = 256 * 1024; // 256 KB

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
