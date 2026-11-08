// What the app password the server makes for a plugin may do. The manifest
// lists Stalwart's permissions (`"appPassword": { "permissions": [...] }`),
// the server makes the app password with exactly those (Stalwart's
// `Replace`), and the connect dialog names them by area. A plugin gets no
// more than it lists, and never what would let it act beyond the user's own
// data: no administration (`sys…`), no other credentials, no impersonation.

/** Every app password needs it to sign in; the server adds it. */
export const SIGN_IN_PERMISSION = 'authenticate';

export const MAX_APP_PASSWORD_PERMISSIONS = 128;

/** The user's own data over JMAP, WebDAV, IMAP, POP3, ManageSieve. */
const DATA_PERMISSION_RE = /^(jmap|dav|imap|pop3|sieve)[A-Z][A-Za-z0-9]{1,62}$/;

/** Further ones a plugin may list; anything else is refused. */
const OTHER_PERMISSIONS = new Set([
  SIGN_IN_PERMISSION,
  'authenticateWithAlias',
  'emailSend',
  'calendarAlarmsSend',
  'calendarSchedulingSend',
]);

/**
 * The manifest's `appPassword` value: its permissions, without duplicates,
 * or an error message.
 */
export function checkAppPasswordPermissions(value: unknown): { permissions: string[] } | { error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'appPassword must be an object with a "permissions" list' };
  }
  const list = (value as Record<string, unknown>).permissions;
  if (!Array.isArray(list) || list.length === 0) return { error: 'appPassword.permissions must list what the plugin needs' };
  if (list.length > MAX_APP_PASSWORD_PERMISSIONS) {
    return { error: `appPassword.permissions takes at most ${MAX_APP_PASSWORD_PERMISSIONS}` };
  }
  const out: string[] = [];
  for (const name of list) {
    if (typeof name !== 'string' || !(DATA_PERMISSION_RE.test(name) || OTHER_PERMISSIONS.has(name))) {
      return { error: `appPassword.permissions: "${String(name)}" is not a permission a plugin may have` };
    }
    if (!out.includes(name)) out.push(name);
  }
  return { permissions: out };
}

/** What the server asks Stalwart for: the listed permissions and sign-in, nothing else. */
export function appPasswordPermissions(permissions: readonly string[]): Record<string, true> {
  const out: Record<string, true> = { [SIGN_IN_PERMISSION]: true };
  for (const name of permissions) out[name] = true;
  return out;
}

export type RightArea = 'calendars' | 'contacts' | 'files' | 'mail' | 'directory' | 'send';

export interface AppPasswordRights {
  /** Each area the permissions reach, in a fixed order; `send` and `directory` are always `read`. */
  areas: { area: RightArea; access: 'read' | 'change' }[];
  /** Permissions no area names, shown as they are. */
  other: string[];
}

const AREAS: [RightArea, RegExp][] = [
  ['send', /^(jmapEmailSubmission|emailSend$|calendarSchedulingSend$|calendarAlarmsSend$)/],
  ['calendars', /^(jmapCalendar|jmapParticipantIdentity|davCal)/],
  ['contacts', /^(jmapAddressBook|jmapContactCard|davCard)/],
  ['files', /^(jmapFileNode|jmapBlob|davFile)/],
  ['mail', /^(jmapEmail|jmapThread|jmapMailbox|jmapSearchSnippet|jmapIdentity|jmapVacationResponse|jmapSieve|imap|pop3|sieve)/],
];

/** Reads only; whatever else a permission does counts as a change. */
const READ_RE = /(Get|Query|Changes|QueryChanges|GetAvailability|Lookup|PropFind|Parse|SyncCollection|ExpandProperty)$/;
const DIRECTORY_READ_RE = /^(jmapPrincipal(Get|Query|Changes|QueryChanges|GetAvailability)|davPrincipal(List|Match|Search|SearchPropSet))$/;

/** The permissions by area, for the connect dialog. */
export function appPasswordRights(permissions: readonly string[]): AppPasswordRights {
  const access = new Map<RightArea, 'read' | 'change'>();
  const other: string[] = [];
  for (const name of permissions) {
    if (name === SIGN_IN_PERMISSION || name === 'authenticateWithAlias') continue;
    if (DIRECTORY_READ_RE.test(name)) {
      access.set('directory', 'read');
      continue;
    }
    const area = AREAS.find(([, re]) => re.test(name))?.[0];
    if (!area) {
      other.push(name);
      continue;
    }
    if (area === 'send') access.set('send', 'read');
    else if (!READ_RE.test(name)) access.set(area, 'change');
    else if (!access.has(area)) access.set(area, 'read');
  }
  const order: RightArea[] = ['mail', 'send', 'calendars', 'contacts', 'files', 'directory'];
  return {
    areas: order.filter((a) => access.has(a)).map((area) => ({ area, access: access.get(area)! })),
    other,
  };
}

/** The name of the app password the server makes for a plugin: the user sees it in their security settings. */
export function appPasswordDescription(pluginName: string): string {
  return `Plugin: ${pluginName.trim().slice(0, 80)}`;
}
