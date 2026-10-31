import type { CredentialSpec } from './plugin-secrets/credentials';
import type { CatalogSlotName } from './plugin-slot-catalog';

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
  /**
   * Accounts and API keys the plugin uses through the server proxy
   * (`api.proxy.fetch`). The secret stays on the server; see
   * lib/plugin-secrets/credentials.ts.
   */
  credentials?: Record<string, CredentialSpec>;
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
  /** Server content hash of a managed theme's CSS + skin; see ServerTheme. */
  contentHash?: string;

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
  /** From the manifest: see PluginManifest.credentials. */
  credentials?: Record<string, CredentialSpec>;
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
  /**
   * For plugins the user installed: the validated manifest, kept so the
   * package can be rebuilt for an approval request, and the hash an admin
   * approval is pinned to (see packageHash in lib/extension-package.ts).
   */
  packageManifest?: Record<string, unknown>;
  approvalHash?: string;
  /** Last answer from the server about this package's approval. */
  approvalStatus?: 'pending' | 'approved' | 'denied' | 'not-requested';
}

// ─── UI Slots ────────────────────────────────────────────────

/** Every slot and action surface; see lib/plugin-slot-catalog.ts. */
export type SlotName = CatalogSlotName;

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
  /** JMAP uid of the event being edited; undefined while composing a new one. */
  uid?: string;
  /** Attendee email addresses currently on the form. */
  attendees: string[];
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
  /**
   * The JMAP account the message is in. Message ids repeat across accounts
   * (own, shared, group), so pass it to email.get / getRaw / getAttachment /
   * setKeyword to name this very message. Always set on what email.get,
   * list and search return; elsewhere set at least when messages of several
   * accounts are listed together.
   */
  accountId?: string;
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
  /**
   * The message's attachments. `blobId` is what `email.getAttachment`
   * takes. Inline images are included and marked. Empty until the host has
   * loaded the message's body structure.
   */
  attachments: { blobId: string; name: string; type: string; size: number; inline: boolean }[];
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

/**
 * The light view of a message used by list-level hooks (new mail, selection,
 * moves): headers and flags, no body or source. Same email:read sensitivity
 * as EmailReadView.
 */
export interface EmailSummary {
  id: string;
  threadId: string;
  mailboxIds: string[];
  from: { name: string; email: string }[];
  to: { name: string; email: string }[];
  subject: string;
  receivedAt: string;
  preview: string;
  keywords: string[];
  hasAttachment: boolean;
  size: number;
  /** See EmailReadView.accountId. */
  accountId?: string;
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
  /** JSCalendar uid, stable across edits and the same for every occurrence. */
  uid: string;
  calendarId: string;
  title: string;
  description: string;
  /** Local start, as stored (ISO 8601 without zone, see `timeZone`). */
  start: string;
  /** ISO 8601 duration, e.g. PT1H. */
  duration: string;
  timeZone: string | null;
  /** UTC start and end when the server computed them. */
  utcStart: string | null;
  utcEnd: string | null;
  isAllDay: boolean;
  location: string;
  status: string;
  /** Attendee addresses, organizer included. */
  participants: { name: string; email: string; role: string; status: string }[];
  isRecurring: boolean;
  keywords: string[];
}

export interface CalendarView {
  id: string;
  name: string;
  color: string;
  isVisible: boolean;
  isDefault: boolean;
  /** Holds tasks only; events can't be put in it. */
  isTasksOnly: boolean;
}

/**
 * What a plugin passes to `api.calendar.createEvent` (and, every field
 * optional, to `updateEvent`). Times are written one of three ways:
 * `2026-05-01` (a day), `2026-05-01T09:30` (a wall-clock time in `timeZone`)
 * or `2026-05-01T07:30:00Z` (UTC). Give `end` or `duration`, not both; with
 * neither an event lasts one hour, or one day when it is all-day.
 */
export interface CalendarEventInput {
  /** 1-500 characters. */
  title: string;
  /** Up to 10,000 characters of plain text. */
  description?: string;
  start: string;
  /** Exclusive: an all-day event on May 1 ends on `2026-05-02`. */
  end?: string;
  /** ISO 8601 duration such as `PT1H30M`, or whole days (`P2D`) when all-day. */
  duration?: string;
  /** IANA zone of a wall-clock `start`. Defaults to the user's zone. */
  timeZone?: string;
  /** Defaults to true when `start` is a date without a time. */
  isAllDay?: boolean;
  /** Up to 500 characters. */
  location?: string;
  /** From `api.calendar.listCalendars()`. Defaults to the default calendar. */
  calendarId?: string;
  /**
   * Attendees, at most 50, stored with the user as organizer. No invitation
   * is sent; the user can send them from the event. An empty array removes
   * them.
   */
  participants?: { email: string; name?: string }[];
  /**
   * Repeat the event. `until` is a date (YYYY-MM-DD); give `count` or
   * `until`, not both. null removes the repetition (updates).
   */
  repeat?: { frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number; count?: number; until?: string } | null;
  /**
   * createEvent only: your own stable id for the event, 1-128 of
   * `A-Z a-z 0-9 . _ : -`. It is stored as `<uid>@<pluginId>.plugin.bulwark`,
   * which is what CalendarEventView.uid then shows, so you can find the
   * event again without remembering its id.
   */
  uid?: string;
}

/** What a plugin passes to `api.tasks.create` (and, every field optional, to `update`). */
export interface TaskInput {
  /** 1-500 characters. */
  title: string;
  /** Up to 10,000 characters of plain text. */
  description?: string;
  /** `2026-05-01` or `2026-05-01T17:00` (wall clock). null removes it on update. */
  due?: string | null;
  /** 0 (none), 1 (highest) to 9 (lowest). */
  priority?: number;
  /** Defaults to the tasks calendar, else the default calendar. */
  calendarId?: string;
  /**
   * The task's reminders by id (1-64 of `A-Z a-z 0-9 . _ -`); a task holds
   * at most 5. On update only the ids named change: an alert given is set
   * (one kept with the same trigger and action stays acknowledged; a new
   * trigger, a snooze, makes it fire again), an id given null is removed,
   * and alerts not named are left as they are. null for the whole map
   * removes every alert. While the task uses its calendar's default alerts
   * (TaskView.useDefaultAlerts), any change makes the defaults the task's
   * own under new ids; `{}` does only that.
   */
  alerts?: Record<string, TaskAlertInput | null> | null;
  /**
   * Links by id (1-64 of `A-Z a-z 0-9 . _ -`), at most 10: an http(s) URL,
   * a `mailto:` address or a path of this Bulwark (`/mail/...`), stored as
   * its full URL. Merged by id on update as `alerts` is; links another app
   * wrote stay unless named with null.
   */
  links?: Record<string, TaskLinkInput | null> | null;
  /**
   * What the task relates to, by a mail's Message-ID (with its angle
   * brackets) or another calendar object's UID; at most 10. Merged by key on
   * update as `alerts` is.
   */
  relatedTo?: Record<string, TaskRelationInput | null> | null;
}

/**
 * When a task's alert fires: an ISO 8601 duration from the task's due
 * (`-PT15M` before, `PT0S` at it; `relativeTo: 'start'` counts from its
 * start, else from its due), at most a year either way; or an instant in
 * UTC (`2026-05-01T07:30:00Z`).
 */
export type TaskAlertTrigger =
  | { offset: string; relativeTo?: 'due' | 'start' }
  | { at: string };

export interface TaskAlertInput {
  trigger: TaskAlertTrigger;
  /** `display` (the default) shows a reminder; `email` has the server send one. */
  action?: 'display' | 'email';
}

export interface TaskLinkInput {
  /** Up to 2048 characters. */
  href: string;
  /** A link relation such as `describedby` or `author` (RFC 8288), lower case. */
  rel?: string;
  /** Up to 500 characters. */
  title?: string;
}

export interface TaskRelationInput {
  /** How it relates, as in JSCalendar: `parent`, `child`, `first`, `next` or another lower-case type; at most 4. */
  relation?: string[];
}

export interface ContactView {
  id: string;
  uid: string;
  addressBookId: string;
  kind: string;
  fullName: string;
  firstName: string;
  lastName: string;
  emails: string[];
  phones: string[];
  company: string;
  notes: string;
  /**
   * Birthdays, anniversaries and other dates, as `--MM-DD` when the year is
   * unknown or `YYYY-MM-DD` when it is known.
   */
  anniversaries: { kind: string; date: string }[];
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
  uid: string;
  title: string;
  description: string;
  isComplete: boolean;
  progress: string;
  dueDate: string | null;
  /** 0 (none) or 1 (highest) to 9 (lowest), as in JSCalendar. */
  priority: number;
  calendarId: string;
  keywords: string[];
  /** By id; as written by any app, not only by plugins. */
  alerts: Record<string, TaskAlertView>;
  /**
   * True while the task uses its calendar's default alerts: `alerts` then
   * shows those defaults, which can't be acknowledged until an update of
   * `alerts` makes them the task's own (under new ids).
   */
  useDefaultAlerts: boolean;
  /** By id; as written by any app (an attachment's link too). */
  links: Record<string, TaskLinkView>;
  /** By Message-ID or UID. */
  relatedTo: Record<string, TaskRelationView>;
}

export interface TaskAlertView {
  /** As in TaskAlertInput; `relativeTo` is always given for an offset. */
  trigger: { offset: string; relativeTo: 'due' | 'start' } | { at: string };
  action: 'display' | 'email';
  /** When the alert was dismissed (UTC), or null while it is not. */
  acknowledged: string | null;
}

export interface TaskLinkView {
  href: string;
  rel: string | null;
  title: string | null;
  contentType: string | null;
}

export interface TaskRelationView {
  relation: string[];
}

export interface TemplateView {
  id: string;
  name: string;
  category: string;
  subject: string;
  body: string;
  isHTML: boolean;
}

/** What a plugin passes to `api.templates.create` (and, every field optional, to `update`). */
export interface TemplateInput {
  /** 1-200 characters. */
  name: string;
  /** Up to 998 characters. */
  subject?: string;
  /** Up to 100,000 characters. When isHTML, sanitised like any HTML a plugin hands the host. */
  body?: string;
  isHTML?: boolean;
  /** Up to 100 characters; '' for none. */
  category?: string;
}

/** What a plugin may change on a sender identity with `api.identities.update`. The address can't be changed. */
export interface IdentityPatch {
  /** Up to 256 characters. */
  name?: string;
  /** At most 10 addresses (`a@example.com` or `Name <a@example.com>`); null or [] removes them. */
  replyTo?: string[] | null;
  /** Up to 20,000 characters; null or '' removes it. */
  textSignature?: string | null;
  /** Up to 100,000 characters, sanitised like a signature typed into Settings; null or '' removes it. */
  htmlSignature?: string | null;
}

/** What a plugin passes to `api.vacation.set`. Fields left out keep their value. */
export interface VacationInput {
  isEnabled: boolean;
  /** Up to 500 characters. */
  subject?: string;
  /** Up to 64,000 characters. Derived from htmlBody when that is given and this is not. */
  textBody?: string;
  /** Up to 64,000 characters, sanitised like the HTML typed into Settings; null removes it. */
  htmlBody?: string | null;
  /** When the reply starts, with a zone (`2026-05-01T00:00:00Z`), or null for now. */
  fromDate?: string | null;
  /** When it ends, or null for open-ended. */
  toDate?: string | null;
}

/**
 * A file the plugin uploaded with `api.jmap.uploadBlob`, to attach to a
 * message it opens or saves.
 */
export interface BlobAttachmentRef {
  blobId: string;
  /** 1-255 characters. */
  name: string;
  /** A media type such as application/pdf. */
  type: string;
  /** Bytes. */
  size: number;
}

/**
 * What a plugin passes to `api.compose.open`. Addresses are
 * `a@example.com` or `Name <a@example.com>`; at most 100 recipients and 20
 * attachments.
 */
export interface ComposeInput {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** One line, up to 998 characters. */
  subject?: string;
  /** Up to 512 KB. Plain text unless isHtml; HTML is sanitised. */
  body?: string;
  isHtml?: boolean;
  attachments?: BlobAttachmentRef[];
}

/** What a plugin passes to `api.drafts.create`: the same fields as ComposeInput. */
export type DraftInput = ComposeInput;

/**
 * What a plugin passes to `api.email.forward`. The host builds the forward
 * (subject with the forward prefix, the plugin's note, the original's
 * header lines and text) and sends it from the user's default address.
 */
export interface EmailForwardInput {
  /** 1-10 recipients, `a@example.com` or `Name <a@example.com>`. */
  to: string[];
  /** A note above the forwarded message, plain text, up to 64 KB. */
  text?: string;
  /**
   * Which attachments of the original go along, by blobId (attachments of
   * that message only). Default: every attachment that isn't an inline image.
   */
  attachments?: string[];
  /** The account the message is in, as on EmailReadView (team and shared mailboxes). */
  accountId?: string;
}

/**
 * What `api.email.forward` resolves to. `declined`: the user didn't let the
 * plugin forward to a new address; `stopped`: a pre-send check or another
 * plugin's onBeforeEmailSend stopped the send.
 */
export type EmailForwardResult =
  | { sent: true; emailId: string | null; to: string[]; scheduledFor: string | null }
  | { sent: false; reason: 'declined' | 'stopped' };

/**
 * What a plugin passes to `api.notifications.show`. The plugin's name is
 * added to what the user sees, so they know who sent it.
 */
export interface NotificationInput {
  /** 1-120 characters, one line. */
  title: string;
  /** Up to 300 characters, one line. */
  body?: string;
  /**
   * 1-64 letters, digits or `. _ : -`. A new notification with the same tag
   * replaces the old one, and onNotificationClick hands the tag back.
   */
  tag?: string;
  /**
   * A link the host shows as a button on the toast and as a link in the
   * notification panel, opened in a new tab. The URL must be http(s) and on
   * a server the plugin already talks to: one of its `httpOrigins`, or the
   * server of one of its proxy credentials.
   */
  action?: { label: string; url: string };
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

/** What `api.app.getInfo()` tells a plugin about the app it runs in. */
export interface AppInfoView {
  /** The product: always "Bulwark Mail". */
  product: string;
  /** The name the administrator gave this installation (APP_NAME), e.g. "Webmail". */
  name: string;
  /** The app's version, e.g. "1.17.0". */
  version: string;
  /** "full", or "lite" for the static build without a server of its own. */
  edition: 'full' | 'lite';
  /** Whether the Stalwart-specific features (filters, vacation, password) are on. */
  stalwartFeatures: boolean;
  /** A demo installation with sample data. */
  demoMode: boolean;
}

/**
 * Features of Bulwark itself that replace what a plugin did, as
 * `api.host.features` tells the plugin (no permission needed). A plugin
 * that does the same job steps back while one is true. Missing on hosts
 * older than 1.19.0, so read it as `api.host?.features?.x === true`.
 */
export interface HostFeaturesView {
  /** The admin turned on the "External" label on mail from outside the organisation (organisation.externalMail.senderLabel). */
  externalSenderLabel: boolean;
  /** The admin turned on the confirm before sending outside the organisation (organisation.externalMail.recipientWarning). */
  externalRecipientWarning: boolean;
}

/** One setting `api.app.searchSettings` found, in the user's language. */
export interface SettingsSearchResult {
  /** The settings page's id: account, appearance, composing, vacation, ... */
  pageId: string;
  /** The page's name as the user sees it. */
  page: string;
  label: string;
  description?: string;
}

/** The user's preferences `api.app.getSettings()` shares: plain values by setting name. */
export type AppSettingsView = Record<string, string | number | boolean | number[] | string[]>;

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
  /** Name of a host icon (see components/icons) shown before the label, e.g. "check" or "user". */
  icon?: string;
}

// ─── Message-list category tabs (Gmail-style inbox tabs) ─────
//
// The tab contract lives in core so tabs render natively: a plugin registers
// tab DEFINITIONS via `api.tabs.set(config)`; the host renders the tab strip
// above the message list, ANDs the active tab's filter into the mailbox
// Email/query, and maintains per-tab unread badges.
//
// A tab selects its messages in one of two ways:
//   1. `query` — a raw JMAP Email FilterCondition/FilterOperator evaluated
//      server-side at view time (search-based tabs). Nothing is written to
//      the messages; classification is a live query (e.g. match the
//      List-Unsubscribe header, or an OR of social sender domains).
//   2. `keyword` — a `hasKeyword` filter (durable tabs). Classification then
//      happens out-of-band — typically a plugin-managed Sieve section at
//      delivery (see filterHooks.onSieveScriptGenerate) or explicit
//      recategorization via `api.tabs.categorize`.
// A tab with NEITHER is the default bucket ("Primary"): it matches messages
// that match none of the other tabs' filters (server-side NOT).

/**
 * One tab in the message-list tab strip.
 */
export interface MessageListTab {
  /** Stable id within the plugin, e.g. "promotions". Used in hooks and counts. */
  id: string;
  /** Display label (localize in the plugin via api.i18n before registering). */
  label: string;
  /**
   * Search-based selection: a JMAP Email FilterCondition or FilterOperator
   * (RFC 8621 §4.4.1), e.g. `{ header: ["List-Unsubscribe"] }` or
   * `{ operator: "OR", conditions: [{ from: "reddit.com" }, ...] }`.
   * The host ANDs it with the mailbox condition. Takes precedence over
   * `keyword` when both are set.
   */
  query?: Record<string, unknown>;
  /**
   * Keyword-based selection, e.g. "$category-promotions" — filters via
   * `hasKeyword`. Use for durable, Sieve-assigned categories.
   */
  keyword?: string | null;
  /**
   * Icon rendered before the label (optional): a Tabler Icons name such as
   * `"inbox"` or `"tabler:inbox"`. Lucide names (`"Inbox"`) from older plugins
   * are still accepted and translated.
   */
  icon?: string;
  /** CSS color for the active-tab indicator / badge accent (optional). */
  color?: string;
  /** Sort order within the strip (ascending, default 100). */
  order?: number;
  /** Show the unread-count badge for this tab. Default true. */
  showUnreadBadge?: boolean;
}

/**
 * Registered by a plugin via `api.tabs.set(config)` (permission
 * `ui:message-list-tabs`). Cleared automatically when the plugin unloads,
 * or explicitly via `api.tabs.clear()`.
 */
export interface MessageListTabsConfig {
  tabs: MessageListTab[];
  /**
   * Mailbox roles the strip renders for. Default ['inbox'] — category tabs
   * on Trash or Sent are almost never what anyone wants.
   */
  mailboxRoles?: string[];
}

/**
 * Passed to messageListTabHooks.onTabActivate observers when the user
 * switches tabs.
 */
export interface TabActivateContext {
  tabId: string;
  previousTabId: string | null;
  /** Store id of the mailbox the strip is filtering. */
  mailboxId: string | null;
}

/**
 * Passed to messageListTabHooks.onBeforeEmailCategorize (intercept — return
 * false to cancel) and onEmailCategorize (observer, after the keyword patch
 * was applied). Describes a host-driven recategorization triggered by
 * `api.tabs.categorize(emailIds, toTabId)` or native UI. Only keyword-based
 * (or default) tabs can be categorize targets — search-based tabs derive
 * membership from their query, so a plugin implements "move to tab" there by
 * updating its query (e.g. a per-sender override) and re-registering.
 */
export interface EmailCategorizeContext {
  emailIds: string[];
  /** Target tab id. */
  toTabId: string;
  /** Keyword added by the move, or null when the target is the default tab. */
  keywordAdded: string | null;
  /** Category keywords removed from the messages by the move. */
  keywordsRemoved: string[];
  /**
   * Unique sender addresses of the affected messages — the hook payload a
   * plugin needs to offer Gmail-style "do this for all mail from X"
   * (per-sender overrides, Sieve regeneration).
   */
  senders: string[];
}

/**
 * Second argument to filterHooks.onSieveScriptGenerate transform handlers.
 * The transform's value is the full Sieve script the host is about to upload
 * as the account's active script; handlers return a modified script (e.g.
 * with a plugin-managed categorizer section appended) or undefined to pass
 * through. Keep `require` statements at the top of the script — the host
 * uploads the returned text verbatim after validation.
 */
export interface SieveScriptGenerateContext {
  /** Account whose active script is being (re)generated. */
  accountId: string | null;
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
   * quoted body, including HTML islands and nested blockquotes (HTML mode only).
   * This preference persists when saving/reopening drafts. Use this for the Outlook style where the
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
 * A file a plugin has already uploaded to the JMAP server (via
 * `api.jmap.uploadBlob`) and wants attached to the email the user is
 * currently composing. Passed to the `onAttach` callback a plugin receives
 * through the `composer-attachment-source` slot's extraProps.
 */
export interface PluginAttachmentUpload {
  /** JMAP blob id of the already-uploaded content. */
  blobId: string;
  name: string;
  type: string;
  size: number;
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
 * Returned by onProvideSearchResults handlers: results from elsewhere (CRM
 * hits, chat messages, ...) for the search that is running. The host draws
 * them as a block above the search's message list, grouped by `source`.
 * A click on an entry that names a message the user can reach (`email`)
 * opens it in the reader, as a click on a row of the list does. Any other
 * click reaches the plugin that returned the entry as `onAction`, with
 * `surface: 'search-results'`, the entry's `key` as `actionId` and the
 * search's `query` in the context. Plain text only, but the snippet may
 * mark what matched as SearchSnippet/get does; see
 * lib/plugin-search-results.ts for the limits.
 */
export interface ExternalSearchResult {
  /** Unique among the plugin's entries for this search; comes back as actionId. */
  key: string;
  title: string;
  /**
   * May wrap what matched in `<mark>`…`</mark>`, highlighted as the list's
   * own search snippets; `&`, `<`, `>` meant as text escaped as `&amp;`,
   * `&lt;`, `&gt;`. No other markup: any other tag shows as text.
   */
  snippet: string;
  /** Group heading, e.g. "CRM", "Slack"; the plugin's name when missing. */
  source?: string;
  /** The message the entry stands for, opened in the reader on a click. */
  email?: SearchResultEmail;
}

/** A message named by a search result. */
export interface SearchResultEmail {
  /** The message's JMAP id. */
  id: string;
  /** The JMAP account holding it (a shared or group account); the signed-in account's own when missing. */
  accountId?: string;
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
  // Read the bytes of a message's attachments and its full source
  // (email.getAttachment / email.getRaw), and of files the user attaches.
  // Arbitrary blob ids (jmap.fetchBlob) stay privileged-tier only.
  'email:blob-read',
  // Upload a file to server (for encrypt).
  'email:blob-write',
  // Replace the rendered body of an opened email (render-takeover).
  'email:render-takeover',
  // Open the composer filled in (api.compose.open). Low risk: the user still
  // has to press Send.
  'compose:open',
  // Read the message being written (api.composer.getBody/getSelection), in
  // a composer that handed the plugin its id.
  'compose:read',
  // Change the message being written (api.composer.replaceSelection/replaceBody).
  'compose:write',
  // Forward a message of the account with its attachments, without the
  // composer (api.email.forward). The host asks the user once per address.
  'email:forward',
  'calendar:read', 'calendar:write',
  'contacts:read', 'contacts:write',
  'files:read', 'files:write',
  'identity:read', 'identity:write',
  'filters:read', 'filters:write',
  'tasks:read', 'tasks:write',
  'templates:read', 'templates:write',
  'vacation:read', 'vacation:write',
  'settings:read', 'settings:write',
  'security:read',
  'auth:observe',
  'auth:emit',
  'account:read',
  // Look people up in the server's directory (api.user.findPeople).
  'directory:read',
  'http:post', 'http:fetch',
  'ui:observe', 'ui:toolbar', 'ui:app-top-banner', 'ui:email-banner', 'ui:email-footer', 'ui:contact-cryptokeys',
  'ui:email-details',
  'ui:download-file',
  // Show a system notification, or a toast when the user hasn't allowed them
  // (api.notifications.show).
  'ui:notifications',
  // Register native message-list category tabs (Gmail-style inbox tabs).
  'ui:message-list-tabs',
  'ui:composer-toolbar', 'ui:composer-sidebar',
  'ui:sidebar-widget', 'ui:settings-section',
  'ui:context-menu', 'ui:navigation-rail', 'ui:keyboard',
  'ui:calendar-action', 'ui:admin-page',
  // Surfaces from the slot catalogue (lib/plugin-slot-catalog.ts).
  'ui:message-list', 'ui:contacts', 'ui:tasks', 'ui:files', 'ui:commands', 'ui:app-page',
  // Requests that carry an account or API key, added by the server (lib/plugin-secrets).
  'http:proxy',
  'admin:config',
  'app:lifecycle',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/**
 * Permissions older plugins may still name that no longer grant anything:
 * `smime:read` covered the built-in S/MIME code, which moved into a plugin.
 * Accepted and dropped at install, with a warning, so those plugins still
 * install.
 */
export const DEPRECATED_PERMISSIONS: readonly string[] = ['smime:read'];

/** Permissions always granted regardless of manifest */
export const IMPLICIT_PERMISSIONS: Permission[] = ['ui:observe', 'app:lifecycle'];

// ─── Validation ──────────────────────────────────────────────

/** Upper bound on tabs a single plugin may register via api.tabs.set. */
export const MAX_MESSAGE_LIST_TABS = 8;

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
  // Every url() except a same-document fragment loads something: a remote
  // host (also written protocol-relative, `url(//host)`), a data: document,
  // a same-origin path. Themes ship no assets, so none is needed.
  /url\s*\(\s*(?!['"]?\s*#)/i,
  // Takes plain strings, so it loads remote images without any url().
  /image-set\s*\(/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /-moz-binding/i,
  /behavior\s*:/i,
];
