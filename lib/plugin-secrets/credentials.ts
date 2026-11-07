// Credentials a plugin may use through the server proxy (/api/plugin-proxy).
// The plugin names a credential by id; the server adds the secret to the
// request and forwards it only to the credential's origin. The secret never
// reaches the plugin.
//
// A plugin declares its credentials in its manifest:
//
//   "credentials": {
//     "nextcloud": { "label": "Nextcloud", "scope": "user", "inject": { "type": "basic" } },
//     "openai": {
//       "label": "OpenAI", "scope": "admin", "inject": { "type": "bearer" },
//       "secretKey": "apiKey", "originKey": "baseUrl"
//     }
//   }
//
// scope "admin": the secret is a `type: "secret"` field of the plugin's admin
// config (configSchema), and the origin is fixed in the manifest (`origin`) or
// read from an admin config field (`originKey`).
// scope "user": the user connects their own account in a dialog the host
// shows; the origin is fixed in the manifest or chosen by the user there.
// With `appPassword: true` (and `inject: { type: "basic" }`) the account is
// the one the user is signed in to: the server makes an app password on it
// and stores it with the login name, so the user types nothing.

export type CredentialInject =
  | { type: 'none' }
  | { type: 'bearer' }
  | { type: 'basic' }
  | { type: 'header'; name: string; prefix?: string };

export interface AdminCredentialSpec {
  label: string;
  scope: 'admin';
  inject: CredentialInject;
  /** configSchema key holding the secret; it must be `type: "secret"`. */
  secretKey: string;
  /** Fixed origin, or */
  origin?: string;
  /** configSchema key holding the origin (a URL; only its origin is used). */
  originKey?: string;
  /** configSchema key holding the user name for basic auth. */
  usernameKey?: string;
}

export interface UserCredentialSpec {
  label: string;
  scope: 'user';
  inject: CredentialInject;
  /** Fixed origin; when absent the user enters the server address. */
  origin?: string;
  /**
   * The server makes the secret: an app password on the mail server the user
   * is signed in to, which is then also the origin. Only with `basic`.
   */
  appPassword?: true;
}

export type CredentialSpec = AdminCredentialSpec | UserCredentialSpec;

export const MAX_CREDENTIALS_PER_PLUGIN = 8;
export const CREDENTIAL_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/** Headers a credential may not set: the proxy or the transport owns them. */
const RESERVED_HEADERS = new Set([
  'host', 'cookie', 'content-length', 'content-type', 'transfer-encoding', 'connection',
  'origin', 'referer', 'forwarded', 'te', 'upgrade', 'keep-alive', 'proxy-authorization',
]);
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * The origin (scheme + host + port) of a URL, or null. https only, except
 * http for origins the admin listed in PLUGIN_PROXY_PRIVATE_ORIGINS.
 */
export function credentialOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && privateProxyOrigins().includes(url.origin)) return url.origin;
  return null;
}

/**
 * Origins on the admin's own network the proxy may reach although they are
 * private addresses (a Nextcloud on the LAN). Comma separated, from
 * PLUGIN_PROXY_PRIVATE_ORIGINS. Everything else must resolve to a public
 * address.
 */
export function privateProxyOrigins(): string[] {
  const raw = (typeof process !== 'undefined' && process.env?.PLUGIN_PROXY_PRIVATE_ORIGINS) || '';
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const url = new URL(trimmed);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.push(url.origin);
    } catch { /* ignore */ }
  }
  return out;
}

export function checkInject(value: unknown): CredentialInject | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'none':
    case 'bearer':
    case 'basic':
      return { type: v.type };
    case 'header': {
      if (typeof v.name !== 'string' || !HEADER_NAME_RE.test(v.name)) return null;
      if (RESERVED_HEADERS.has(v.name.toLowerCase())) return null;
      if (v.prefix !== undefined && (typeof v.prefix !== 'string' || v.prefix.length > 32 || /[\r\n]/.test(v.prefix))) return null;
      return { type: 'header', name: v.name, ...(typeof v.prefix === 'string' ? { prefix: v.prefix } : {}) };
    }
    default:
      return null;
  }
}

/**
 * Check a manifest's `credentials` block. `configSchema` is the manifest's
 * admin config schema, which admin credentials must point into.
 */
export function checkCredentials(
  value: unknown,
  configSchema: Record<string, { type?: string }> | undefined,
): { credentials?: Record<string, CredentialSpec>; errors: string[] } {
  if (value === undefined) return { errors: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { errors: ['credentials must be an object'] };
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CREDENTIALS_PER_PLUGIN) {
    return { errors: [`At most ${MAX_CREDENTIALS_PER_PLUGIN} credentials`] };
  }
  const errors: string[] = [];
  const out: Record<string, CredentialSpec> = {};
  for (const [id, raw] of entries) {
    const where = `credentials.${id}`;
    if (!CREDENTIAL_ID_RE.test(id)) { errors.push(`${where}: invalid id`); continue; }
    if (!raw || typeof raw !== 'object') { errors.push(`${where} must be an object`); continue; }
    const c = raw as Record<string, unknown>;
    if (typeof c.label !== 'string' || !c.label.trim() || c.label.length > 80) { errors.push(`${where}.label is required (max 80 characters)`); continue; }
    const inject = checkInject(c.inject);
    if (!inject) { errors.push(`${where}.inject is invalid`); continue; }
    let fixedOrigin: string | undefined;
    if (c.origin !== undefined) {
      const origin = credentialOrigin(c.origin);
      if (!origin) { errors.push(`${where}.origin must be an https origin`); continue; }
      fixedOrigin = origin;
    }
    if (c.scope === 'user') {
      if (c.appPassword !== undefined && c.appPassword !== true) { errors.push(`${where}.appPassword must be true`); continue; }
      if (c.appPassword && inject.type !== 'basic') { errors.push(`${where}.appPassword needs inject "basic"`); continue; }
      out[id] = {
        label: c.label, scope: 'user', inject,
        ...(fixedOrigin ? { origin: fixedOrigin } : {}),
        ...(c.appPassword ? { appPassword: true as const } : {}),
      };
      continue;
    }
    if (c.scope !== 'admin') { errors.push(`${where}.scope must be "admin" or "user"`); continue; }
    if (c.appPassword !== undefined) { errors.push(`${where}.appPassword is only for scope "user"`); continue; }
    const field = (key: unknown, name: string, type?: string): string | null => {
      if (typeof key !== 'string' || !configSchema?.[key]) {
        errors.push(`${where}.${name} must name a configSchema field`);
        return null;
      }
      if (type && configSchema[key].type !== type) {
        errors.push(`${where}.${name} must name a "${type}" field`);
        return null;
      }
      return key;
    };
    const secretKey = field(c.secretKey, 'secretKey', 'secret');
    if (!secretKey) continue;
    if (!fixedOrigin && c.originKey === undefined) { errors.push(`${where} needs origin or originKey`); continue; }
    const originKey = c.originKey === undefined ? undefined : field(c.originKey, 'originKey');
    if (originKey === null) continue;
    const usernameKey = c.usernameKey === undefined ? undefined : field(c.usernameKey, 'usernameKey');
    if (usernameKey === null) continue;
    out[id] = {
      label: c.label, scope: 'admin', inject, secretKey,
      ...(fixedOrigin ? { origin: fixedOrigin } : {}),
      ...(originKey ? { originKey } : {}),
      ...(usernameKey ? { usernameKey } : {}),
    };
  }
  return { credentials: errors.length ? undefined : out, errors };
}

/** The name of the app password the server makes for a plugin: the user sees it in their security settings. */
export function appPasswordDescription(pluginName: string): string {
  return `Plugin: ${pluginName.trim().slice(0, 80)}`;
}

/** The header to add for a secret, or null when the credential adds none. */
export function authHeaderFor(
  inject: CredentialInject,
  secret: string | undefined,
  username: string | undefined,
): [string, string] | null {
  if (!secret || inject.type === 'none') return null;
  switch (inject.type) {
    case 'bearer':
      return ['authorization', `Bearer ${secret}`];
    case 'basic':
      return ['authorization', `Basic ${Buffer.from(`${username ?? ''}:${secret}`, 'utf8').toString('base64')}`];
    case 'header':
      return [inject.name.toLowerCase(), `${inject.prefix ?? ''}${secret}`];
  }
}
