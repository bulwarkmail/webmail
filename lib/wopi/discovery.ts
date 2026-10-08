import { configManager } from '@/lib/admin/config-manager';
import { logger } from '@/lib/logger';

/**
 * WOPI client discovery (#425).
 *
 * A WOPI client (Collabora Online, OnlyOffice/EuroOffice, ...) publishes the
 * document types it can open and the editor URL for each action at
 * `<client>/hosting/discovery`:
 *
 *   <wopi-discovery><net-zone><app name="writer">
 *     <action name="edit" ext="odt" urlsrc="https://office.example/browser/abc/cool.html?"/>
 *   ...
 *
 * The admin configures `wopiClientUrl`; we fetch and cache the discovery XML
 * server-side (the URL is operator-supplied and may be on a private network,
 * so it deliberately does NOT go through the public-URL guard).
 */

export interface WopiActions {
  /** extension (lowercase, no dot) -> editor urlsrc for the "edit" action */
  edit: Record<string, string>;
  /** extension -> urlsrc for the "view" action */
  view: Record<string, string>;
}

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
// An unreachable editor is asked again sooner, but not on every request: the
// proxy reads the discovery for the CSP of each page it serves (#1130).
const DISCOVERY_FAILURE_TTL_MS = 30 * 1000;
const DISCOVERY_TIMEOUT_MS = 5000;
/** How long a page response waits for a discovery it has never seen. */
const CSP_DISCOVERY_WAIT_MS = 2000;

interface DiscoveryState {
  cache: { url: string; fetchedAt: number; actions: WopiActions | null } | null;
  inflight: { url: string; promise: Promise<WopiActions | null> } | null;
}

// The proxy and the route handlers are bundled separately; keeping the cache
// on globalThis lets them share one discovery fetch (see config-manager.ts).
const STATE_KEY = Symbol.for('bulwark.wopi.discovery');
type GlobalWithDiscovery = typeof globalThis & { [STATE_KEY]?: DiscoveryState };
const g = globalThis as GlobalWithDiscovery;
const state: DiscoveryState = (g[STATE_KEY] ??= { cache: null, inflight: null });

function isFresh(cache: NonNullable<DiscoveryState['cache']>): boolean {
  const ttl = cache.actions ? DISCOVERY_TTL_MS : DISCOVERY_FAILURE_TTL_MS;
  return Date.now() - cache.fetchedAt < ttl;
}

export async function getWopiClientUrl(): Promise<string> {
  await configManager.ensureLoaded();
  return configManager.get<string>('wopiClientUrl', '').trim().replace(/\/+$/, '');
}

function discoveryUrlFor(clientUrl: string): string {
  try {
    const url = new URL(clientUrl);
    // A bare origin means "the editor's base URL" - discovery lives at the
    // well-known path. A URL with a path is taken as the discovery URL itself.
    if (url.pathname === '/' || url.pathname === '') {
      return `${url.origin}/hosting/discovery`;
    }
    return clientUrl;
  } catch {
    return '';
  }
}

export function parseWopiDiscovery(xml: string): WopiActions {
  const actions: WopiActions = { edit: {}, view: {} };
  const tags = xml.match(/<action\b[^>]*\/?>/gi) || [];
  for (const tag of tags) {
    const attr = (name: string): string => {
      const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'));
      return m?.[1] ?? '';
    };
    const name = attr('name').toLowerCase();
    const ext = attr('ext').toLowerCase();
    const urlsrc = attr('urlsrc');
    if (!ext || !urlsrc) continue;
    if (name === 'edit' && !actions.edit[ext]) actions.edit[ext] = urlsrc;
    if (name === 'view' && !actions.view[ext]) actions.view[ext] = urlsrc;
  }
  return actions;
}

/**
 * Fetch (with a short cache) the configured WOPI client's action map.
 * Returns null when no client is configured or discovery is unreachable.
 */
export async function getWopiActions(): Promise<WopiActions | null> {
  const clientUrl = await getWopiClientUrl();
  if (!clientUrl) return null;
  const discoveryUrl = discoveryUrlFor(clientUrl);
  if (!discoveryUrl) return null;

  if (state.cache && state.cache.url === discoveryUrl && isFresh(state.cache)) {
    return state.cache.actions;
  }
  if (state.inflight?.url === discoveryUrl) return state.inflight.promise;

  const promise = fetchWopiActions(discoveryUrl).then((actions) => {
    state.cache = { url: discoveryUrl, fetchedAt: Date.now(), actions };
    if (state.inflight?.promise === promise) state.inflight = null;
    return actions;
  });
  state.inflight = { url: discoveryUrl, promise };
  return promise;
}

async function fetchWopiActions(discoveryUrl: string): Promise<WopiActions | null> {
  try {
    const res = await fetch(discoveryUrl, {
      headers: { Accept: 'text/xml' },
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!res.ok) {
      logger.warn('WOPI discovery fetch failed', { discoveryUrl, status: res.status });
      return null;
    }
    const actions = parseWopiDiscovery(await res.text());
    if (Object.keys(actions.edit).length === 0 && Object.keys(actions.view).length === 0) {
      logger.warn('WOPI discovery returned no actions', { discoveryUrl });
      return null;
    }
    return actions;
  } catch (error) {
    logger.warn('WOPI discovery unreachable', {
      discoveryUrl,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return null;
  }
}

function httpOrigin(url: string): string {
  try {
    const parsed = new URL(url.replace(/<[^>]*>/g, ''));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : '';
  } catch {
    return '';
  }
}

/**
 * The origins the browser loads the editor from, for the page CSP (#1130).
 *
 * `wopiClientUrl` is where the server fetches discovery, which behind a
 * reverse proxy is often an internal address the browser never sees; the
 * editor itself is served from the origins of the discovery `urlsrc`s (for
 * Collabora, its `server_name`). Both are returned. A discovery that went
 * stale is used as is and refreshed in the background, so only the first page
 * after boot (or after an outage) waits for the editor.
 */
export async function getWopiEditorOrigins(): Promise<string[]> {
  const clientUrl = await getWopiClientUrl();
  if (!clientUrl) return [];
  const discoveryUrl = discoveryUrlFor(clientUrl);

  let actions: WopiActions | null = null;
  const cached = state.cache?.url === discoveryUrl ? state.cache : null;
  if (cached && (cached.actions || isFresh(cached))) {
    actions = cached.actions;
    if (!isFresh(cached)) void getWopiActions();
  } else if (discoveryUrl) {
    actions = await Promise.race([
      getWopiActions(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), CSP_DISCOVERY_WAIT_MS)),
    ]);
  }

  const origins = new Set<string>();
  const add = (url: string) => {
    const origin = httpOrigin(url);
    if (origin) origins.add(origin);
  };
  add(clientUrl);
  if (actions) {
    for (const urlsrc of [...Object.values(actions.edit), ...Object.values(actions.view)]) add(urlsrc);
  }
  return Array.from(origins);
}

/** UI language as a BCP 47 tag, or '' when it is not one. */
function languageTag(lang: string | undefined): string {
  const tag = (lang ?? '').trim();
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : '';
}

/**
 * Build the editor launch URL from a discovery `urlsrc` and the WOPISrc of
 * the file. Placeholder groups like `<ui=UI_LLCC&>` are optional per the WOPI
 * spec: the language ones are filled in from `lang`, the rest are dropped.
 * Collabora's discovery has no placeholders and reads a `lang` parameter
 * instead, so that is added when the urlsrc names no language itself (#1130).
 */
export function buildWopiActionUrl(urlsrc: string, wopiSrc: string, lang?: string): string {
  const tag = languageTag(lang);
  const base = urlsrc.replace(/<([^=<>]+)=([^&<>]*)&?>/g, (_group, name: string, placeholder: string) =>
    tag && (placeholder === 'UI_LLCC' || placeholder === 'DC_LLCC') ? `${name}=${tag}&` : '',
  ).replace(/<[^>]*>/g, '');
  const sep = base.includes('?')
    ? (base.endsWith('?') || base.endsWith('&') ? '' : '&')
    : '?';
  const language = tag && !/[?&](?:lang|ui)=/.test(base) ? `lang=${tag}&` : '';
  return `${base}${sep}${language}WOPISrc=${encodeURIComponent(wopiSrc)}`;
}
