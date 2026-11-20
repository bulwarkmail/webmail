/**
 * CardDAV and CalDAV sources for the mailbox migration: discovery from the
 * URL the admin or user entered, collection and member listing, and
 * multiget with a GET-per-object fallback for servers that refuse it.
 *
 * Every request goes through fetchPublicUrl (or an injected fetch), which
 * never follows redirects; they are followed here so each hop is checked again.
 */

import { readTextCapped, UpstreamBodyTooLargeError } from '@/lib/security/capped-body';
import { DisallowedUrlError, fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';
import { SourceError, type DavCollection, type DavObject, type DavObjectRef, type DavSource } from './types';
import {
  APPLE_ICAL_NS,
  CALDAV_NS,
  CALSERVER_NS,
  CARDDAV_NS,
  DAV_NS,
  MAX_XML_LENGTH,
  XmlError,
  addressData,
  calendarColor,
  calendarData,
  currentUserPrincipal,
  displayName,
  getContentType,
  getEtag,
  hasProps,
  homeSet,
  isNotFound,
  parseMultistatus,
  resourceType,
  supportedComponents,
  type DavResponse,
} from './dav-xml';

export interface DavRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type DavFetchResponse = PublicFetchResponse | Response;

/** One HTTP request, no redirects followed. `allowPrivateHost` as fetchPublicUrl takes it. */
export type DavFetch = (
  url: string,
  init: DavRequestInit,
  options: { allowPrivateHost?: string },
) => Promise<DavFetchResponse>;

export interface DavSourceOptions {
  kind: 'carddav' | 'caldav';
  url: string;
  username: string;
  password: string;
  /** The configured host may be an intranet name (admin-entered); plain http is allowed then too. */
  allowPrivateHost: boolean;
  fetch?: DavFetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BODY_BYTES = MAX_XML_LENGTH;
const MAX_REDIRECTS = 5;
const MULTIGET_CHUNK = 50;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_BOOK_SEGMENTS = new Set(['contacts', 'default', 'addressbook', 'personal']);
const DEFAULT_BOOK_NAMES = new Set(['contacts', 'kontakte']);
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'HOSTNAME_MISMATCH',
]);

const defaultFetch: DavFetch = (url, init, options) =>
  fetchPublicUrl(url, init as Parameters<typeof fetchPublicUrl>[1], options);

const PREFIXES: Record<string, string> = {
  [DAV_NS]: 'd',
  [CARDDAV_NS]: 'card',
  [CALDAV_NS]: 'cal',
  [APPLE_ICAL_NS]: 'ical',
  [CALSERVER_NS]: 'cs',
};

type PropName = [ns: string, local: string];

function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, (c) => `&${({ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' })[c]};`);
}

function xmlBody(rootNs: string, root: string, props: PropName[], hrefs: string[] = []): string {
  const ns = Object.entries(PREFIXES).map(([uri, prefix]) => ` xmlns:${prefix}="${escapeXml(uri)}"`).join('');
  const propXml = props.map(([uri, local]) => `<${PREFIXES[uri]}:${local}/>`).join('');
  const hrefXml = hrefs.map((href) => `<d:href>${escapeXml(href)}</d:href>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>\n<${PREFIXES[rootNs]}:${root}${ns}><d:prop>${propXml}</d:prop>${hrefXml}</${PREFIXES[rootNs]}:${root}>`;
}

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const { code, name } = current as { code?: unknown; name?: unknown };
    if (typeof code === 'string') codes.push(code);
    if (typeof name === 'string') codes.push(name);
    current = (current as { cause?: unknown }).cause;
  }
  return codes;
}

const isTlsCode = (code: string) => TLS_CODES.has(code) || /^(CERT_|ERR_TLS_|ERR_SSL_)/.test(code);

/** A thrown fetch failure as a SourceError. Only the host goes into the message. */
function toSourceError(err: unknown, host: string): SourceError {
  if (err instanceof SourceError) return err;
  if (err instanceof DisallowedUrlError || errorCodes(err).includes('EDISALLOWED')) {
    return new SourceError(`${host} is not an address the server may connect to`, 'blocked', { cause: err });
  }
  if (err instanceof XmlError) return new SourceError(`${host} sent XML that could not be read: ${err.message}`, 'protocol', { cause: err });
  if (err instanceof UpstreamBodyTooLargeError) return new SourceError(`${host} sent an answer that is too large`, 'protocol', { cause: err });
  const codes = errorCodes(err);
  const tls = codes.find(isTlsCode);
  if (tls) return new SourceError(`Secure connection to ${host} failed (${tls})`, 'tls', { cause: err });
  if (codes.includes('TimeoutError') || codes.includes('AbortError')) {
    return new SourceError(`${host} did not answer in time`, 'network', { cause: err });
  }
  const code = codes.find((c) => /^E[A-Z_]+$/.test(c) || c.startsWith('UND_ERR'));
  return new SourceError(`Could not reach ${host}${code ? ` (${code})` : ''}`, 'network', { cause: err });
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Compares resources the way servers mean them: encoding and trailing slash aside. */
function resourceKey(url: URL): string {
  return `${url.origin}${decodePath(url.pathname).replace(/\/+$/, '')}`;
}

function resolveHref(href: string, base: URL): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

function lastSegment(url: URL): string {
  const segments = url.pathname.split('/').filter(Boolean);
  return decodePath(segments[segments.length - 1] ?? '');
}

/** #rrggbb from #rrggbb, #rrggbbaa or #rgb; undefined for anything else. */
export function normalizeColor(raw: string | undefined): string | undefined {
  const match = raw?.trim().match(/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$|^#([0-9a-f]{3})$/i);
  if (!match) return undefined;
  const hex = match[1] ?? match[2].replace(/./g, (c) => c + c);
  return `#${hex.toLowerCase()}`;
}

interface DavAnswer {
  status: number;
  /** The URL that answered, after redirects: the base for hrefs in the answer. */
  url: URL;
  etag: string | null;
  text: string;
}

export function createDavSource(opts: DavSourceOptions): DavSource {
  const doFetch = opts.fetch ?? defaultFetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const authorization = `Basic ${Buffer.from(`${opts.username}:${opts.password}`, 'utf8').toString('base64')}`;
  const isCard = opts.kind === 'carddav';
  /** Collection hrefs as listed, to the URL that listed them. */
  const known = new Map<string, URL>();

  let configured: URL | null = null;
  function configuredUrl(): URL {
    if (configured) return configured;
    let url: URL;
    try {
      url = new URL(opts.url);
    } catch {
      throw new SourceError('The DAV address is not a valid URL', 'protocol');
    }
    checkUrl(url);
    configured = url;
    return url;
  }

  function checkUrl(url: URL): void {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new SourceError(`${url.protocol} addresses are not allowed for DAV`, 'blocked');
    }
    if (url.protocol === 'http:' && !opts.allowPrivateHost) {
      throw new SourceError(`DAV addresses must use https (${url.host})`, 'blocked');
    }
  }

  /** The credential goes to the configured origin, or its https upgrade, and nowhere else. */
  function mayAuthenticate(url: URL): boolean {
    const origin = configuredUrl();
    if (url.origin === origin.origin) return true;
    return origin.protocol === 'http:' && url.protocol === 'https:' && url.hostname === origin.hostname;
  }

  async function request(method: string, start: URL, extra: { depth?: '0' | '1'; body?: string } = {}): Promise<DavAnswer> {
    const fetchOptions = opts.allowPrivateHost ? { allowPrivateHost: configuredUrl().hostname } : {};
    let url = start;
    let currentMethod = method;
    let body = extra.body;
    for (let hop = 0; ; hop++) {
      checkUrl(url);
      const headers: Record<string, string> = {};
      if (extra.depth !== undefined && body !== undefined) headers.depth = extra.depth;
      if (body !== undefined) headers['content-type'] = 'application/xml; charset=utf-8';
      if (mayAuthenticate(url)) headers.authorization = authorization;

      let res: DavFetchResponse;
      try {
        res = await doFetch(url.href, { method: currentMethod, headers, body, signal: AbortSignal.timeout(timeoutMs) }, fetchOptions);
      } catch (err) {
        throw toSourceError(err, url.host);
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        discard(res);
        const location = res.headers.get('location');
        const next = location ? resolveHref(location, url) : null;
        if (!next) throw new SourceError(`${url.host} answered ${res.status} without a usable Location`, 'protocol');
        if (hop >= MAX_REDIRECTS) throw new SourceError(`${url.host} redirected too many times`, 'protocol');
        // 303 means "GET the answer there"; DAV clients keep the method on 301/302.
        if (res.status === 303 && currentMethod !== 'GET') {
          currentMethod = 'GET';
          body = undefined;
        }
        url = next;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        discard(res);
        throw new SourceError(`${url.host} refused the login (${res.status})`, 'auth');
      }

      let text = '';
      if (res.status >= 200 && res.status < 300) {
        try {
          text = await readTextCapped(res, MAX_BODY_BYTES);
        } catch (err) {
          throw toSourceError(err, url.host);
        }
      } else {
        discard(res);
      }
      return { status: res.status, url, etag: res.headers.get('etag'), text };
    }
  }

  function statusError(answer: DavAnswer, method: string): SourceError {
    const transient = answer.status === 429 || answer.status >= 500;
    return new SourceError(`${answer.url.host} answered ${answer.status} to ${method}`, transient ? 'network' : 'protocol');
  }

  function multistatus(answer: DavAnswer): DavResponse[] {
    try {
      return parseMultistatus(answer.text);
    } catch (err) {
      throw toSourceError(err, answer.url.host);
    }
  }

  async function propfind(url: URL, depth: '0' | '1', props: PropName[]): Promise<{ url: URL; responses: DavResponse[] }> {
    const answer = await request('PROPFIND', url, { depth, body: xmlBody(DAV_NS, 'propfind', props) });
    if (answer.status !== 207) throw statusError(answer, 'PROPFIND');
    return { url: answer.url, responses: multistatus(answer) };
  }

  /** The response about `url` itself in a Depth 0 answer. */
  function self(responses: DavResponse[], url: URL): DavResponse | undefined {
    const key = resourceKey(url);
    return responses.find((r) => resolveHref(r.href, url) && resourceKey(resolveHref(r.href, url)!) === key) ?? responses[0];
  }

  const homeProp: PropName = isCard ? [CARDDAV_NS, 'addressbook-home-set'] : [CALDAV_NS, 'calendar-home-set'];
  const collectionProps: PropName[] = isCard
    ? [[DAV_NS, 'resourcetype'], [DAV_NS, 'displayname'], [CALSERVER_NS, 'getctag']]
    : [
      [DAV_NS, 'resourcetype'],
      [DAV_NS, 'displayname'],
      [CALSERVER_NS, 'getctag'],
      [APPLE_ICAL_NS, 'calendar-color'],
      [CALDAV_NS, 'supported-calendar-component-set'],
    ];

  function toCollections(responses: DavResponse[], base: URL): DavCollection[] {
    const collections: Array<DavCollection & { segment: string }> = [];
    for (const response of responses) {
      const type = resourceType(response);
      if (!(isCard ? type.addressbook : type.calendar)) continue;
      const url = resolveHref(response.href, base);
      if (!url) continue;
      known.set(response.href, url);
      const segment = lastSegment(url);
      const name = displayName(response) ?? (segment || response.href);
      collections.push(isCard
        ? { href: response.href, name, segment }
        : {
          href: response.href,
          name,
          segment,
          ...(normalizeColor(calendarColor(response)) ? { color: normalizeColor(calendarColor(response)) } : {}),
          components: supportedComponents(response),
        });
    }
    if (isCard && collections.length) {
      const preferred = collections.find((c) => DEFAULT_BOOK_SEGMENTS.has(c.segment.toLowerCase()) || DEFAULT_BOOK_NAMES.has(c.name.toLowerCase()))
        ?? collections[0];
      for (const c of collections) c.isDefault = c === preferred;
    }
    return collections.map(({ segment: _segment, ...collection }) => collection);
  }

  async function listCollections(): Promise<DavCollection[]> {
    const start = configuredUrl();
    const first = await propfind(start, '0', [[DAV_NS, 'current-user-principal'], homeProp, ...collectionProps]);
    const entry = self(first.responses, first.url);
    const type = resourceType(entry);
    // The address entered may already be the book or calendar itself.
    if (entry && (isCard ? type.addressbook : type.calendar)) return toCollections([entry], first.url);

    let home: URL | null = null;
    const ownHome = homeSet(entry, opts.kind)[0];
    if (ownHome) {
      home = resolveHref(ownHome, first.url);
    } else {
      const principalHref = currentUserPrincipal(entry);
      const principal = principalHref ? resolveHref(principalHref, first.url) : null;
      if (principal) {
        const found = await propfind(principal, '0', [homeProp]);
        const href = homeSet(self(found.responses, found.url), opts.kind)[0];
        if (href) home = resolveHref(href, found.url);
      }
    }
    // No home set anywhere: the address entered is the home.
    const listing = await propfind(home ?? first.url, '1', collectionProps);
    return toCollections(listing.responses, listing.url);
  }

  function collectionUrl(collectionHref: string): URL {
    const url = known.get(collectionHref) ?? resolveHref(collectionHref, configuredUrl());
    if (!url) throw new SourceError(`Not a usable collection address: ${collectionHref}`, 'protocol');
    return url;
  }

  function isMember(response: DavResponse, url: URL): boolean {
    const type = (getContentType(response) ?? '').split(';')[0].trim().toLowerCase();
    const path = url.pathname.toLowerCase();
    if (isCard) return !type || type === 'text/vcard' || type === 'text/x-vcard' || path.endsWith('.vcf');
    return !type || type === 'text/calendar' || path.endsWith('.ics');
  }

  async function listObjects(collectionHref: string): Promise<DavObjectRef[]> {
    const collection = collectionUrl(collectionHref);
    const answer = await propfind(collection, '1', [[DAV_NS, 'resourcetype'], [DAV_NS, 'getetag'], [DAV_NS, 'getcontenttype']]);
    const own = new Set([resourceKey(collection), resourceKey(answer.url)]);
    const refs: DavObjectRef[] = [];
    for (const response of answer.responses) {
      const url = resolveHref(response.href, answer.url);
      if (!url || own.has(resourceKey(url)) || !hasProps(response)) continue;
      if (resourceType(response).collection || !isMember(response, url)) continue;
      refs.push({ href: response.href, etag: getEtag(response) ?? '' });
    }
    return refs;
  }

  /** The multiget answer for `hrefs`, or null when the server refused the REPORT. */
  async function multiget(collection: URL, hrefs: string[]): Promise<{ objects: DavObject[]; answered: Set<string> } | null> {
    const dataProp: PropName = isCard ? [CARDDAV_NS, 'address-data'] : [CALDAV_NS, 'calendar-data'];
    const sent = hrefs.map((href) => (/^[a-z][a-z0-9+.-]*:/i.test(href) ? resolveHref(href, collection)?.pathname ?? href : href));
    const body = xmlBody(dataProp[0], isCard ? 'addressbook-multiget' : 'calendar-multiget', [[DAV_NS, 'getetag'], dataProp], sent);
    const answer = await request('REPORT', collection, { depth: '1', body });
    if (answer.status !== 207) return null;
    let responses: DavResponse[];
    try {
      responses = parseMultistatus(answer.text);
    } catch {
      return null;
    }

    const wanted = new Map<string, string>();
    for (const href of hrefs) {
      const url = resolveHref(href, collection);
      if (url) wanted.set(resourceKey(url), href);
    }
    const objects: DavObject[] = [];
    const answered = new Set<string>();
    for (const response of responses) {
      const url = resolveHref(response.href, answer.url);
      const href = url && wanted.get(resourceKey(url));
      if (!href || answered.has(href)) continue;
      const data = isCard ? addressData(response) : calendarData(response);
      if (data?.trim()) {
        objects.push({ href, etag: getEtag(response) ?? '', data });
        answered.add(href);
      } else if (isNotFound(response)) {
        answered.add(href);
      }
    }
    return { objects, answered };
  }

  async function getOne(collection: URL, href: string): Promise<DavObject | null> {
    const url = resolveHref(href, collection);
    if (!url) return null;
    const answer = await request('GET', url);
    if (answer.status === 404 || answer.status === 410) return null;
    if (answer.status !== 200) throw statusError(answer, 'GET');
    return { href, etag: answer.etag ?? '', data: answer.text };
  }

  async function fetchObjects(collectionHref: string, hrefs: string[]): Promise<DavObject[]> {
    const collection = collectionUrl(collectionHref);
    const out: DavObject[] = [];
    for (let i = 0; i < hrefs.length; i += MULTIGET_CHUNK) {
      const chunk = hrefs.slice(i, i + MULTIGET_CHUNK);
      const got = await multiget(collection, chunk);
      if (got) out.push(...got.objects);
      for (const href of chunk) {
        if (got?.answered.has(href)) continue;
        const object = await getOne(collection, href);
        if (object) out.push(object);
      }
    }
    return out;
  }

  return { listCollections, listObjects, fetchObjects };
}

function discard(res: DavFetchResponse): void {
  (res.body as ReadableStream<Uint8Array> | null)?.cancel().catch(() => {});
}
