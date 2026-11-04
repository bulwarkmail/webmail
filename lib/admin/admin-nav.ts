/**
 * The admin panel's pages and their URLs.
 *
 * Every page lives at `/admin/<id>`; plugins, themes and the marketplace
 * have a detail page below it (`/admin/plugins/<pluginId>`). The whole tree
 * is one Next route (app/(main)/admin/[[...segments]]) and switching pages
 * goes through history.pushState, so the sidebar never starts a route
 * transition - the same way the user settings keep their permalinks (#733).
 *
 * This module is plain data: the connector registry imports it on the
 * server, so no React in here. Icons live in the shell.
 */

export const ADMIN_PAGE_IDS = [
  'dashboard',
  'settings',
  'auth',
  'branding',
  'policy',
  'organisation',
  'org-signatures',
  'org-templates',
  'org-security',
  'org-sharing',
  'org-labels',
  'org-proofreading',
  'org-calendars',
  'org-notices',
  'org-devices',
  'plugins',
  'themes',
  'marketplace',
  'version',
  'telemetry',
  'monitoring',
  'logs',
] as const;

export type AdminPageId = typeof ADMIN_PAGE_IDS[number];

export function isAdminPageId(value: string | null | undefined): value is AdminPageId {
  return typeof value === 'string' && (ADMIN_PAGE_IDS as readonly string[]).includes(value);
}

/** `top` has no heading in the sidebar; the others do. */
export type AdminPageGroup = 'top' | 'organisation' | 'extensions' | 'system';

export interface AdminSectionDef {
  /** The `id` the page gives its SettingsSection, for jump links and search. */
  id: string;
  title: string;
  /** Extra words the sidebar search matches, besides the title. */
  keywords?: string;
}

export interface AdminPageDef {
  id: AdminPageId;
  label: string;
  /** One line under the page title. */
  description: string;
  group: AdminPageGroup;
  /** Words the sidebar search matches, besides the label and the sections. */
  keywords: string;
  sections: readonly AdminSectionDef[];
  /** Whether `/admin/<id>/<detail>` opens a detail page. */
  hasDetail?: boolean;
}

export const ADMIN_PAGES: readonly AdminPageDef[] = [
  {
    id: 'dashboard',
    label: 'Overview',
    description: 'What this Bulwark is running and what needs attention',
    group: 'top',
    keywords: 'dashboard home status warnings accounts activity recent',
    sections: [],
  },
  {
    id: 'settings',
    label: 'Server',
    description: 'How this Bulwark connects and what the login page offers',
    group: 'top',
    keywords: 'settings application name jmap server url demo mode stalwart features search engine indexing',
    sections: [
      { id: 'general', title: 'General', keywords: 'app name jmap url custom endpoint demo mode stalwart indexing' },
      { id: 'login', title: 'Login page', keywords: 'version 2fa totp code access token remember me heading subtitle' },
      { id: 'servers', title: 'JMAP servers', keywords: 'multi server domain auto pick list' },
      { id: 'wopi', title: 'Document editing', keywords: 'wopi collabora onlyoffice office files host url' },
      { id: 'bimi', title: 'Brand logos', keywords: 'bimi vmc cmc mark certificate sender logo icon dmarc' },
      { id: 'logging', title: 'Logging', keywords: 'log level format json text debug' },
      { id: 'sync', title: 'Settings sync', keywords: 'session secret devices' },
    ],
  },
  {
    id: 'auth',
    label: 'Authentication',
    description: 'OAuth, single sign-on, admin access and session security',
    group: 'top',
    keywords: 'login password oidc openid',
    sections: [
      { id: 'oauth', title: 'OAuth / OpenID Connect', keywords: 'client id secret issuer scopes private endpoints auto configure stalwart' },
      { id: 'sso', title: 'Single sign-on', keywords: 'auto sso redirect end session logout provider post-logout' },
      { id: 'admin-access', title: 'Admin access', keywords: 'stalwart admin dashboard password automatic' },
      { id: 'session', title: 'Session and security', keywords: 'cookie samesite frame ancestors parent origin embed' },
    ],
  },
  {
    id: 'branding',
    label: 'Branding',
    description: 'Logos, colours and company details, per domain if needed',
    group: 'top',
    keywords: 'logo favicon icon company imprint privacy website domain',
    sections: [
      { id: 'scope', title: 'Scope', keywords: 'domain host wildcard default' },
      { id: 'images', title: 'Images and logos', keywords: 'favicon app logo login logo light dark upload' },
      { id: 'pwa', title: 'Progressive web app', keywords: 'pwa icon screenshot short name description theme colour background colour install' },
      { id: 'company', title: 'Company information', keywords: 'company name imprint privacy policy website url' },
    ],
  },
  {
    id: 'policy',
    label: 'Features and settings',
    description: 'Which features users get, which settings they may change, and what they start with, for everyone or one domain or group',
    group: 'organisation',
    keywords: 'user policy features gates restrictions lock hide users defaults presets scope domain group',
    sections: [
      { id: 'features', title: 'Features', keywords: 'calendar contacts files smime templates keywords sidebar apps unified mailbox archive custom from debug export' },
      { id: 'push-relays', title: 'Push relays', keywords: 'notifications relay url default lock' },
      { id: 'sidebar-apps', title: 'Default sidebar apps', keywords: 'apps rail intranet inline tab icon' },
      { id: 'restrictions', title: 'Locked settings', keywords: 'restrict hide lock font size density layout delete action reply mode session timeout notifications debug' },
    ],
  },
  {
    id: 'organisation',
    label: 'Domains and groups',
    description: 'Give some domains or groups their own settings, see what applies to a user, and keep the policy in one file',
    group: 'organisation',
    keywords: 'organisation organization scope domain group department customer tenant effective policy export import file json',
    sections: [
      { id: 'scopes', title: 'Domains and groups', keywords: 'scope domain group add remove order' },
      { id: 'effective', title: 'Effective policy', keywords: 'user address lookup applies source' },
      { id: 'policy-file', title: 'Policy file', keywords: 'export import download upload json backup git' },
    ],
  },
  {
    id: 'org-signatures',
    label: 'Signatures',
    description: 'The signature and legal disclaimer every message carries',
    group: 'organisation',
    keywords: 'signature disclaimer footer legal imprint placeholder phone title department lock',
    sections: [
      { id: 'signature', title: 'Signature', keywords: 'template placeholder name email lock' },
      { id: 'details', title: 'User details', keywords: 'phone mobile title department fields' },
      { id: 'disclaimer', title: 'Disclaimer', keywords: 'footer legal notice confidentiality' },
    ],
  },
  {
    id: 'org-templates',
    label: 'Templates',
    description: 'Templates every user can pick, and what users may keep of their own',
    group: 'organisation',
    keywords: 'templates library snippets canned responses team personal',
    sections: [
      { id: 'library', title: 'Organisation library', keywords: 'templates read-only shared add edit' },
      { id: 'user-templates', title: 'Personal and team templates', keywords: 'personal team group lock hide' },
      { id: 'vacation-templates', title: 'Out-of-office replies', keywords: 'vacation away auto reply out of office absence deputy placeholder' },
    ],
  },
  {
    id: 'org-security',
    label: 'Security',
    description: 'Warnings about mail from and to outside the organisation, phishing reports, sign-out times and outside connections',
    group: 'organisation',
    keywords: 'security external warning label recipients domains session timeout idle sign out third party traffic privacy',
    sections: [
      { id: 'external', title: 'External mail', keywords: 'external sender label recipient warning organisation domains contacts' },
      { id: 'phishing', title: 'Phishing reports', keywords: 'phishing report spam abuse security desk arf forward' },
      { id: 'sessions', title: 'Sessions', keywords: 'idle timeout maximum length sign out warning' },
      { id: 'third-party', title: 'Third-party traffic', keywords: 'telemetry favicon relay directory outgoing hosts privacy gdpr' },
    ],
  },
  {
    id: 'org-sharing',
    label: 'Sharing',
    description: 'Tags in shared mailboxes, delegates and recovering deleted items',
    group: 'organisation',
    keywords: 'sharing shared mailbox tags delegate access recover deleted items archive',
    sections: [
      { id: 'shared-tags', title: 'Shared tags', keywords: 'tags labels colours group mailbox edit lock' },
      { id: 'delegates', title: 'Delegates', keywords: 'delegate access mail calendar contacts rights read write' },
      { id: 'recovery', title: 'Recover deleted items', keywords: 'recover restore deleted archive enterprise' },
    ],
  },
  {
    id: 'org-labels',
    label: 'Classification',
    description: 'Labels such as Internal or Confidential that users pick when they write, and that arrive with the message',
    group: 'organisation',
    keywords: 'classification label sensitivity confidential internal public vs-nfd sio-label header subject prefix required',
    sections: [
      { id: 'labels', title: 'Classification labels', keywords: 'labels presets default required header prefix colour' },
    ],
  },
  {
    id: 'org-proofreading',
    label: 'Proofreading',
    description: 'Spelling and grammar checks while users write: required, off, or their choice',
    group: 'organisation',
    keywords: 'proofreading spelling grammar spell check languagetool writing language mandatory required',
    sections: [
      { id: 'proofreading', title: 'Proofreading', keywords: 'checker plugin required lock language force' },
    ],
  },
  {
    id: 'org-calendars',
    label: 'Calendars',
    description: 'Company calendars every user sees, free/busy sharing and out-of-office in the calendar',
    group: 'organisation',
    keywords: 'calendar ics feed subscription holidays company free busy availability out of office vacation',
    sections: [
      { id: 'company-calendars', title: 'Company calendars', keywords: 'ics feed url subscription holidays read-only colour' },
      { id: 'free-busy', title: 'Free/busy sharing', keywords: 'free busy availability group share find a time' },
      { id: 'out-of-office', title: 'Out-of-office', keywords: 'vacation away busy block calendar lock' },
    ],
  },
  {
    id: 'org-notices',
    label: 'Notices',
    description: 'An announcement across the apps, and how long Trash and Junk keep mail',
    group: 'organisation',
    keywords: 'announcement banner notice maintenance message retention trash junk days',
    sections: [
      { id: 'announcement', title: 'Announcement', keywords: 'banner message severity start end dismiss languages' },
      { id: 'retention', title: 'Trash and Junk', keywords: 'retention days deleted expunge trash junk' },
    ],
  },
  {
    id: 'org-devices',
    label: 'Devices',
    description: 'What users may save, print or keep on their devices',
    group: 'organisation',
    keywords: 'device download export print watermark install pwa push notification offline data loss',
    sections: [
      { id: 'devices', title: 'Downloads, printing and notifications', keywords: 'download attachment export print watermark install prompt push sender subject' },
      { id: 'offline', title: 'Offline mode', keywords: 'offline cache device keep mail outbox' },
      { id: 'registered', title: 'Registered devices', keywords: 'device registry wipe remote lost stolen laptop remove desktop app browser' },
    ],
  },
  {
    id: 'plugins',
    label: 'Plugins',
    description: 'Plugins installed for every user, and what users may install themselves',
    group: 'extensions',
    keywords: 'extensions addons upload zip approve permissions configure force enable always on default off',
    sections: [
      { id: 'policy', title: 'Plugins for users', keywords: 'plugins enabled master switch user uploads require approval policy' },
      { id: 'approvals', title: 'Approval requests', keywords: 'approve deny user uploaded code review' },
      { id: 'installed', title: 'Installed plugins', keywords: 'enable disable remove roll back configure' },
    ],
    hasDetail: true,
  },
  {
    id: 'themes',
    label: 'Themes',
    description: 'Themes installed for every user, defaults and what users may pick',
    group: 'extensions',
    keywords: 'colour color mode dark light default upload zip',
    sections: [
      { id: 'installed', title: 'Installed themes', keywords: 'enable disable remove roll back' },
      { id: 'policy', title: 'Theme policy', keywords: 'themes enabled user uploads default theme colour mode lock' },
      { id: 'offered', title: 'Offered to users', keywords: 'built-in themes hide' },
    ],
    hasDetail: true,
  },
  {
    id: 'marketplace',
    label: 'Marketplace',
    description: 'Plugins and themes from the extension directory',
    group: 'extensions',
    keywords: 'directory install update browse extensions advisories',
    sections: [],
    hasDetail: true,
  },
  {
    id: 'version',
    label: 'Updates',
    description: 'The running version and the hourly update check',
    group: 'system',
    keywords: 'version release upgrade check security advisory',
    sections: [
      { id: 'status', title: 'Status', keywords: 'running latest release severity advisory' },
      { id: 'schedule', title: 'Schedule', keywords: 'last checked next' },
      { id: 'source', title: 'Source', keywords: 'endpoint disabled env' },
    ],
  },
  {
    id: 'telemetry',
    label: 'Usage stats',
    description: 'The anonymous daily heartbeat, off unless you turn it on',
    group: 'system',
    keywords: 'telemetry heartbeat anonymous consent privacy',
    sections: [
      { id: 'status', title: 'Status', keywords: 'enable disable consent error counts' },
      { id: 'accounts', title: 'Account activity', keywords: 'active total logins' },
      { id: 'endpoint', title: 'Endpoint', keywords: 'collector url' },
      { id: 'payload', title: 'Payload preview', keywords: 'send now json' },
    ],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    description: 'Error reports, metrics, health checks and tracing for your own tools',
    group: 'system',
    keywords: 'monitoring errors sentry bugsink glitchtip dsn prometheus metrics health probes tracing opentelemetry otel',
    sections: [
      { id: 'errors', title: 'Error reporting', keywords: 'dsn sentry bugsink glitchtip sample rate environment' },
      { id: 'errors-today', title: 'Errors today', keywords: 'count fingerprint top' },
      { id: 'metrics', title: 'Metrics', keywords: 'prometheus scrape token grafana' },
      { id: 'health', title: 'Health checks', keywords: 'liveness readiness probe kubernetes docker' },
      { id: 'tracing', title: 'Tracing', keywords: 'opentelemetry otel otlp jaeger tempo spans traceparent' },
    ],
  },
  {
    id: 'logs',
    label: 'Audit log',
    description: 'Who changed what in this panel, and when',
    group: 'system',
    keywords: 'audit history actions login config policy ip',
    sections: [],
  },
];

const PAGE_BY_ID = new Map(ADMIN_PAGES.map((page) => [page.id, page]));

export function adminPageDef(id: AdminPageId): AdminPageDef {
  return PAGE_BY_ID.get(id)!;
}

export const ADMIN_ROOT = '/admin';

/** Where in the admin panel a pathname points. `page` null is the index. */
export interface AdminLocation {
  page: AdminPageId | null;
  /** The id or slug of a detail page, for pages that have them. */
  detail: string | null;
}

/**
 * Reads the admin location from a pathname (without the base path, as
 * `usePathname()` gives it). Null when the path is not inside /admin.
 * An unknown page name counts as the index rather than a 404: the login and
 * password routes are separate pages and never get here.
 */
export function parseAdminPath(pathname: string): AdminLocation | null {
  if (pathname !== ADMIN_ROOT && !pathname.startsWith(`${ADMIN_ROOT}/`)) return null;
  const segments = pathname
    .slice(ADMIN_ROOT.length)
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    });
  if (segments.length === 0) return { page: null, detail: null };
  const [first, ...rest] = segments;
  if (!isAdminPageId(first)) return { page: null, detail: null };
  const def = adminPageDef(first);
  const detail = def.hasDetail && rest.length > 0 ? rest.join('/') : null;
  return { page: first, detail };
}

/** The app-relative path of a page, or of one of its detail pages. */
export function adminPath(page?: AdminPageId | null, detail?: string | null): string {
  if (!page) return ADMIN_ROOT;
  const base = `${ADMIN_ROOT}/${page}`;
  return detail ? `${base}/${encodeURIComponent(detail)}` : base;
}
