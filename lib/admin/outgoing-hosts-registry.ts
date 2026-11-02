/**
 * Every outside host Bulwark itself knows about, what talks to it, and what
 * turns it off (#903). The admin view (/api/admin/outgoing-hosts) and the
 * tests read this; the browser only needs the host names and the switches in
 * lib/outgoing-hosts.ts, so none of this prose ends up in client chunks.
 *
 * lib/__tests__/outgoing-hosts.test.ts scans the source for host literals and
 * fails on any that isn't accounted for here, in the file it is listed for.
 * lib/__tests__/outgoing-hosts-mode.test.ts turns the mode on and checks
 * every entry's switch.
 */

export type OutgoingSide = 'server' | 'browser';

export interface OutgoingHost {
  /** Stable id, used by the tests and the admin list. */
  id: string;
  /** The host as people should read it. */
  host: string;
  /** How the host appears in the source after the scheme, when it differs from `host`. */
  literals?: string[];
  /** The files that may name it. */
  files: string[];
  /** Who opens the connection: this server, or the user's browser. */
  side: OutgoingSide;
  /** What uses it, in one sentence. */
  usedBy: string;
  /** How to turn it off without the mode. */
  off: string;
  /** What the mode does instead. */
  inMode: string;
  /** Also present in Bulwark Lite. */
  lite: boolean;
}

export const OUTGOING_HOSTS: readonly OutgoingHost[] = [
  {
    id: 'telemetry',
    host: 'telemetry.bulwarkmail.org',
    files: ['lib/telemetry/types.ts'],
    side: 'server',
    usedBy: 'Anonymous daily heartbeat, sent only after an admin turned telemetry on; with instant error counts on, also the current day\'s error counts as they change.',
    off: 'Off by default. BULWARK_TELEMETRY=off, or System > Usage stats (switch it off or clear the collector URL).',
    inMode: 'Never sent, whatever the telemetry setting says.',
    lite: false,
  },
  {
    id: 'version-check',
    host: 'version.telemetry.bulwarkmail.org',
    files: ['lib/version-check/types.ts'],
    side: 'server',
    usedBy: 'Hourly check for a newer Bulwark release, shown to admins.',
    off: 'BULWARK_UPDATE_CHECK=off, or BULWARK_UPDATE_CHECK_URL= (empty).',
    inMode: 'Not checked; System > Updates says why. Checks resume when the switch goes off.',
    lite: false,
  },
  {
    id: 'push-relay',
    host: 'notifications.relay.bulwarkmail.org',
    files: ['lib/push-relays.ts', 'app/api/dev-jmap/[...path]/route.ts'],
    side: 'browser',
    usedBy: 'Built-in Web Push relay that wakes the browser for new mail.',
    off: 'Add your own relays under Admin > User policy > Push relays and lock the choice.',
    inMode: 'Not offered. Push works only with a relay the admin configured; existing registrations move to it or are removed.',
    lite: false,
  },
  {
    id: 'extension-directory',
    host: 'extensions.bulwarkmail.org',
    files: ['lib/admin/directory-keys.ts', 'lib/admin/marketplace-directory.ts', 'lib/admin/types.ts'],
    side: 'server',
    usedBy: 'Marketplace browsing, installs and update checks in the admin panel.',
    off: 'EXTENSION_DIRECTORY_URL pointing at a self-hosted directory.',
    inMode: 'Off, unless extensionDirectoryUrl points at another host.',
    lite: false,
  },
  {
    id: 'connector',
    host: 'connector.bulwarkmail.org',
    files: ['lib/connector/registry.ts'],
    side: 'server',
    usedBy: 'Links in the docs and the directory that open this instance; the connector asks this server what it can open.',
    off: 'CONNECTOR_ENABLED=false.',
    inMode: 'The capabilities endpoint the connector asks answers 404.',
    lite: false,
  },
  {
    id: 'favicons',
    host: 'icons.duckduckgo.com',
    files: ['app/api/favicon/route.ts'],
    side: 'server',
    usedBy: 'Sender icons next to messages, fetched by /api/favicon.',
    off: 'Users can turn sender icons off in Settings > Message list.',
    inMode: 'Avatars show initials; /api/favicon answers 403 before any request.',
    lite: false,
  },
  {
    id: 'bimi',
    host: '<sender domain> (BIMI)',
    // The hosts come from the sender's DNS records; no literal in the source.
    literals: [],
    files: [],
    side: 'server',
    usedBy: 'Brand logos (BIMI) for messages that pass DMARC, looked up by /api/bimi: TXT records at the sender\'s domain, then the logo, mark certificate and CRL they name.',
    off: 'Users can turn sender icons off in Settings > Message list.',
    inMode: 'Avatars show no brand logos; /api/bimi answers 403 before any lookup.',
    lite: false,
  },
  {
    id: 'translate',
    host: 'api.mymemory.translated.net',
    files: ['app/api/translate/route.ts'],
    side: 'server',
    usedBy: 'Default provider of /api/translate, which the Translate plugin calls.',
    off: 'Set LIBRETRANSLATE_URL to your own LibreTranslate and pick it in the plugin.',
    inMode: 'Refused with 403; LibreTranslate at LIBRETRANSLATE_URL still works.',
    lite: false,
  },
  {
    id: 'maps',
    host: 'www.google.com',
    files: ['lib/event-links.ts'],
    side: 'browser',
    usedBy: 'Tapping the address of a calendar event opens Google Maps.',
    off: 'Nothing else turns it off; it is a link the user taps.',
    inMode: 'The address is plain text with a copy button.',
    lite: true,
  },
  {
    id: 'wkd',
    host: 'openpgpkey.<recipient domain>',
    literals: ['openpgpkey.'],
    files: ['lib/plugin-sandbox/host-api.ts'],
    side: 'browser',
    usedBy: 'OpenPGP key lookup (WKD) at the recipient\'s domain, for PGP plugins.',
    off: 'Don\'t install a PGP plugin that looks keys up.',
    inMode: 'The lookup is refused.',
    lite: false,
  },
  {
    id: 'dev-avatars',
    host: 'randomuser.me',
    literals: ['randomuser.me', 'img.freepik.com'],
    files: ['components/ui/avatar.tsx', 'app/api/dev-jmap/[...path]/route.ts'],
    side: 'browser',
    usedBy: 'Sample sender and contact photos, only with the built-in mock server (DEV_MOCK_JMAP=true).',
    off: 'Don\'t run the mock server.',
    inMode: 'Not shown.',
    lite: false,
  },
];

/**
 * Hosts in the source that Bulwark never connects to on its own: docs links,
 * XML namespaces, credits, examples in comments and sample text. Each is
 * allowed only in the files named, so the same host turning up somewhere new
 * has to be looked at again.
 */
export const NON_REQUEST_HOSTS: readonly { host: string; files: readonly string[]; why: string }[] = [
  { host: 'bulwarkmail.org', why: 'docs links, comments and the contact URL in User-Agent headers', files: ['app/(main)/admin/_pages/telemetry.tsx', 'app/api/fetch-ical/route.ts', 'app/api/translate/route.ts', 'components/admin/org/sections/recovery-section.tsx', 'components/admin/org/sections/company-calendars-section.tsx', 'components/admin/org/sections/free-busy-section.tsx', 'components/admin/org/sections/labels-section.tsx', 'components/admin/org/sections/out-of-office-calendar-section.tsx', 'components/admin/org/sections/phishing-report-section.tsx', 'instrumentation.node.ts', 'lib/telemetry/state.ts', 'lib/telemetry/types.ts', 'app/(main)/admin/_pages/monitoring.tsx', 'lib/admin/types.ts', 'lib/error-reporting/client.ts', 'lib/error-reporting/lite.ts', 'lib/error-reporting/scrub.ts', 'instrumentation.ts', 'app/api/health/live/route.ts', 'app/api/health/ready/route.ts', 'app/api/metrics/route.ts', 'lib/metrics/index.ts', 'lib/tracing/config.ts', 'lib/tracing/scrub.ts', 'lib/tracing/start.ts'] },
  { host: 'bulwarkmail.org', why: 'docs links of the Notices, Devices (offline mode too) and out-of-office template pages', files: ['components/admin/org/sections/announcement-section.tsx', 'components/admin/org/sections/devices-section.tsx', 'components/admin/org/sections/offline-section.tsx', 'components/admin/org/sections/retention-section.tsx', 'components/admin/org/sections/vacation-templates-section.tsx'] },
  { host: 'bulwarkmail.com', why: 'JMAP capability URI', files: ['lib/jmap/client.ts'] },
  { host: 'develop.sentry.dev', why: 'link to the envelope format in a comment', files: ['lib/error-reporting/envelope.ts'] },
  { host: 'extensions.bulwarkmail.org', why: 'signed statement type URIs', files: ['lib/admin/directory-keys.ts'] },
  { host: 'www.w3.org', why: 'XML namespaces', files: ['components/ui/flag-icons.tsx', 'lib/favicon-badge.ts'] },
  { host: 'creativecommons.org', why: 'licence metadata inside an SVG', files: ['components/ui/flag-icons.tsx'] },
  { host: 'github.com', why: 'source code link (AGPL) and SVG metadata', files: ['components/settings/about-data-settings.tsx', 'components/ui/flag-icons.tsx'] },
  { host: 'www.rfc-editor.org', why: 'comments', files: ['lib/jmap/client.ts'] },
  { host: 'devguide.calconnect.org', why: 'comment', files: ['lib/jmap/client.ts'] },
  { host: 'stalw.art', why: 'comment', files: ['app/api/auth/impersonate/route.ts'] },
  { host: 'tabler.io', why: 'icon credit link', files: ['app/(main)/admin/_pages/policy.tsx'] },
  { host: 'www.youtube-nocookie.com', why: 'example in a comment', files: ['lib/plugin-types.ts'] },
  { host: 'bulwark-webmail.vercel.app', why: 'sample message text', files: ['stores/email-store.ts'] },
  { host: 'randomuser.me', why: 'docs links in a comment of the mock server', files: ['app/api/dev-jmap/[...path]/route.ts'] },
  { host: 'schema.org', why: 'vocabulary names in booking markup, matched and never requested', files: ['lib/structured-mail/extract.ts'] },
];

/**
 * Files that build an http(s) URL from a variable or name the scheme alone
 * (for checks and placeholders). The host there comes from configuration,
 * user input or the data around it, never from a built-in default; each is
 * listed with the reason.
 */
export const BUILT_URL_FILES: readonly { file: string; why: string }[] = [
  { file: 'app/(main)/admin/_pages/marketplace-detail.tsx', why: "link to an extension's source host, from the directory's answer" },
  { file: 'app/(main)/setup/page.tsx', why: "the instance's own origin, and scheme checks of the admin-entered server URL" },
  { file: 'app/api/plugin-secrets/route.ts', why: "scheme check of a credential's server URL" },
  { file: 'lib/admin/organisation-policy.ts', why: 'parses and normalises the company calendar feed URLs an admin entered (webcal to https)' },
  { file: 'components/admin/org/sections/company-calendars-section.tsx', why: 'checks the company calendar feed URL the admin is typing' },
  { file: 'components/calendar/ical-subscription-modal.tsx', why: "webcal:// rewritten to https:// for a feed the user enters" },
  { file: 'components/email/rich-text-editor.tsx', why: "adds the scheme to a link address the user types in the editor" },
  { file: 'lib/admin/branding-asset.ts', why: "scheme checks of admin-configured branding URLs" },
  { file: 'lib/auth/pair-bundle.ts', why: "scheme checks of the paired server URL" },
  { file: 'lib/calendar-subscription-sync.ts', why: "webcal:// rewritten to https:// for a feed the user subscribed to" },
  { file: 'lib/email-sanitization.ts', why: "comment about links in mail" },
  { file: 'lib/idn.ts', why: "parses a host name the user typed" },
  { file: 'lib/plugin-sandbox/connect-dialog.ts', why: "adds the scheme to a server address the user enters" },
  { file: 'lib/plugin-sandbox/host-api.ts', why: "WKD lookup at the recipient's domain (registered as wkd), and an error message" },
  { file: 'lib/validation.ts', why: "scheme checks" },
  { file: 'lib/vcard.ts', why: "scheme checks of contact URLs" },
  { file: 'stores/calendar-store.ts', why: "webcal:// rewritten to https:// for a feed the user subscribed to" },
];

/** Folders whose host literals are sample mail content, never requests. */
export const NON_REQUEST_PATHS: readonly string[] = [
  'lib/demo/fixtures/',
];

const RESERVED_TLDS = new Set(['example', 'test', 'invalid', 'localhost', 'local', 'internal', 'lan']);

/** IPv4 literals in private, loopback, link-local, shared, documentation and other reserved ranges. */
export function isReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

/**
 * Hosts that can't be anyone else's: example and reserved names, single
 * labels, private or reserved IP literals and CSP wildcards. Placeholders and
 * tests use them. A public IP literal is not one.
 */
export function isPlaceholderHost(raw: string): boolean {
  const host = raw.toLowerCase().replace(/:\d+$/, '').replace(/\.+$/, '');
  if (/^[\d.]+$/.test(host)) return isReservedIPv4(host);
  if (!host.includes('.') || host.includes('*')) return true;
  const labels = host.split('.');
  const tld = labels[labels.length - 1];
  if (RESERVED_TLDS.has(tld)) return true;
  return /(^|\.)example\.(com|org|net)$/.test(host);
}

/** Every host literal the registry accounts for, with the files that may name it. */
export function registeredLiterals(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const entry of OUTGOING_HOSTS) {
    for (const literal of entry.literals ?? [entry.host]) {
      const files = out.get(literal) ?? new Set<string>();
      for (const file of entry.files) files.add(file);
      out.set(literal, files);
    }
  }
  return out;
}

/** The exact host names of the registry, which the browser module repeats. */
export function registryHostnames(): string[] {
  return OUTGOING_HOSTS.flatMap((entry) => entry.literals ?? [entry.host]).filter((h) => !h.endsWith('.'));
}

