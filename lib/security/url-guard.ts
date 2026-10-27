import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import {
  Agent,
  Client,
  buildConnector,
  fetch as undiciFetch,
  type Dispatcher,
  type RequestInit as UndiciRequestInit,
  type Response as UndiciResponse,
} from 'undici';
import { isPrivateAddress } from './ip-ranges';

const BLOCKED_HOSTNAMES = new Set(['localhost']);
const BLOCKED_HOSTNAME_SUFFIXES = ['.localhost', '.local', '.internal', '.arpa', '.localdomain'];

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function isBlockedIpAddress(hostname: string): boolean {
  return isPrivateAddress(normalizeHostname(hostname));
}

function isBlockedHostname(hostname: string): boolean {
  if (!hostname) return true;
  if (BLOCKED_HOSTNAMES.has(hostname)) return true;
  return BLOCKED_HOSTNAME_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/**
 * Synchronous part of the guard: protocol, embedded credentials, blocked
 * hostnames / suffixes, and literal IP addresses. Returns the parsed URL when
 * those checks pass, `null` otherwise. Does NOT touch DNS.
 */
function parseAllowedUrl(urlString: string): URL | null {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const hostname = normalizeHostname(url.hostname);
  if (isBlockedHostname(hostname)) return null;
  if (isBlockedIpAddress(hostname)) return null;

  return url;
}

/**
 * Returns true only when the URL targets a public host reachable over http(s).
 * Rejects every non-public range in {@link isPrivateAddress} (loopback,
 * RFC 1918, link-local, CGNAT, multicast, IPv6 transition forms), special hostname
 * suffixes (.local, .internal, .arpa, ...), URLs with embedded credentials,
 * and any hostname whose DNS resolves to a blocked address.
 *
 * This is a point-in-time check: the DNS answer it sees is not the one the
 * eventual socket will use, so on its own it is vulnerable to DNS rebinding.
 * Anything that actually connects to a caller-supplied URL must go through
 * {@link fetchPublicUrl}, which re-validates the resolved address inside the
 * socket's own lookup (GHSA-24w9-8r42-8jwm).
 */
export async function isPublicHttpUrl(urlString: string): Promise<boolean> {
  const url = parseAllowedUrl(urlString);
  if (!url) return false;

  const hostname = normalizeHostname(url.hostname);
  if (isIP(hostname)) return true;

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) return false;
    return records.every((record) => !isBlockedIpAddress(record.address));
  } catch {
    return false;
  }
}

/** Thrown by {@link fetchPublicUrl} when the URL (or the address it resolved to) is not public. */
export class DisallowedUrlError extends Error {
  readonly code = 'EDISALLOWED';

  constructor(public readonly url: string, cause?: unknown) {
    super('URL is not allowed', cause === undefined ? undefined : { cause });
    this.name = 'DisallowedUrlError';
  }
}

/** Raised from inside the socket lookup when the resolved address is blocked. */
export class BlockedAddressError extends Error {
  readonly code = 'EBLOCKED';

  constructor(public readonly hostname: string, public readonly address: string | null) {
    super(
      address
        ? `Refusing to connect to ${hostname}: resolved to blocked address ${address}`
        : `Refusing to connect to blocked hostname ${hostname}`,
    );
    this.name = 'BlockedAddressError';
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/**
 * `net.connect`-compatible `lookup` that refuses to hand back a blocked
 * address. Because the socket is created with the address this function
 * returns, there is no window between validation and connect for a rebinding
 * DNS server to exploit.
 *
 * Honours `options.all` (Node's happy-eyeballs path passes it) and the
 * callback-only shorthand.
 */
export function guardedLookup(
  hostname: string,
  options: LookupOptions | number | LookupCallback,
  callback?: LookupCallback,
): void {
  let cb: LookupCallback;
  let opts: LookupOptions;
  if (typeof options === 'function') {
    cb = options;
    opts = {};
  } else {
    cb = callback as LookupCallback;
    opts = typeof options === 'number' ? { family: options } : (options ?? {});
  }

  const normalized = normalizeHostname(hostname);
  if (isBlockedHostname(normalized) || isBlockedIpAddress(normalized)) {
    queueMicrotask(() => cb(new BlockedAddressError(hostname, isIP(normalized) ? normalized : null)));
    return;
  }

  lookup(normalized, { family: opts.family, hints: opts.hints, all: true, verbatim: true })
    .then((records) => {
      if (records.length === 0) {
        const err: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        err.code = 'ENOTFOUND';
        cb(err);
        return;
      }
      const blocked = records.find((record) => isBlockedIpAddress(record.address));
      if (blocked) {
        cb(new BlockedAddressError(hostname, blocked.address));
        return;
      }
      if (opts.all) {
        cb(null, records);
      } else {
        cb(null, records[0].address, records[0].family);
      }
    })
    .catch((err: NodeJS.ErrnoException) => cb(err));
}

let publicDispatcher: Dispatcher | null = null;

/**
 * Shared undici Agent whose sockets resolve hostnames through
 * {@link guardedLookup}. Lazily built so importing this module stays cheap.
 */
export function getPublicDispatcher(): Dispatcher {
  if (!publicDispatcher) {
    // net's LookupFunction type marks the callback's address as required even
    // though Node itself calls back with just an error; the cast bridges that.
    publicDispatcher = new Agent({ connect: { lookup: guardedLookup as unknown as LookupFunction } });
  }
  return publicDispatcher;
}

/**
 * The outbound proxy Node's own fetch would use for this URL, or null: the
 * environment proxy only applies with NODE_USE_ENV_PROXY=1 (or
 * --use-env-proxy), picked and skipped (NO_PROXY) the way Node's fetch does.
 */
export function envProxyFor(url: URL): URL | null {
  const env = process.env;
  const enabled = env.NODE_USE_ENV_PROXY === '1'
    || process.execArgv.includes('--use-env-proxy')
    || /(^|\s)--use-env-proxy(\s|$)/.test(env.NODE_OPTIONS ?? '');
  if (!enabled) return null;

  const httpProxy = env.http_proxy ?? env.HTTP_PROXY;
  const raw = url.protocol === 'https:' ? (env.https_proxy ?? env.HTTPS_PROXY ?? httpProxy) : httpProxy;
  if (!raw) return null;

  const noProxy = env.no_proxy ?? env.NO_PROXY ?? '';
  if (noProxy.trim() === '*') return null;
  const hostname = normalizeHostname(url.hostname);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  for (const entry of noProxy.split(/[,\s]/)) {
    if (!entry) continue;
    const parsed = entry.match(/^(.+):(\d+)$/);
    const host = (parsed ? parsed[1] : entry).replace(/^\*?\./, '').toLowerCase();
    if (parsed && Number(parsed[2]) !== port) continue;
    if (hostname === host || hostname.endsWith(`.${host}`)) return null;
  }

  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function lookupChecked(hostname: string): Promise<string> {
  return new Promise((resolve, reject) => {
    guardedLookup(hostname, {}, (err, address) => (err ? reject(err) : resolve(address as string)));
  });
}

const proxiedDispatchers = new Map<string, Dispatcher>();

/**
 * Like {@link getPublicDispatcher}, but through an outbound proxy (#1367).
 * Handing the proxy the hostname would let the proxy's DNS pick the address
 * and bypass the private-address check, so each connection resolves and
 * checks the name here, then asks the proxy to CONNECT to exactly that
 * address. The request keeps its Host header, and TLS inside the tunnel uses
 * the hostname for SNI and the certificate check.
 */
function getProxiedPublicDispatcher(proxy: URL): Dispatcher {
  let dispatcher = proxiedDispatchers.get(proxy.href);
  if (dispatcher) return dispatcher;

  const proxyClient = new Client(proxy.origin);
  const proxyAuth = proxy.username || proxy.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
    : null;
  const tlsInTunnel = buildConnector({});
  const connect: buildConnector.connector = (opts, callback) => {
    const hostname = normalizeHostname(opts.hostname);
    const port = Number(opts.port) || (opts.protocol === 'https:' ? 443 : 80);
    lookupChecked(hostname)
      .then(async (address) => {
        const authority = `${isIP(address) === 6 ? `[${address}]` : address}:${port}`;
        const tunnel = await proxyClient.connect({
          path: authority,
          headers: { host: authority, ...(proxyAuth ? { 'proxy-authorization': proxyAuth } : {}) },
        });
        // The tunnel is the proxy connection's own socket (typed as a Duplex).
        const socket = tunnel.socket as Socket;
        const { statusCode } = tunnel;
        if (statusCode !== 200) {
          socket.destroy();
          throw new Error(`Proxy answered ${statusCode} to CONNECT ${authority}`);
        }
        if (opts.protocol !== 'https:') {
          callback(null, socket);
          return;
        }
        const servername = opts.servername || (isIP(hostname) ? undefined : hostname);
        tlsInTunnel({ ...opts, servername, httpSocket: socket }, callback);
      })
      .catch((err: Error) => callback(err, null));
  };
  dispatcher = new Agent({ connect });
  proxiedDispatchers.set(proxy.href, dispatcher);
  return dispatcher;
}

function findBlockedCause(err: unknown, depth = 0): BlockedAddressError | null {
  if (depth > 5 || !(err instanceof Error)) return null;
  if (err instanceof BlockedAddressError) return err;
  if ((err as NodeJS.ErrnoException).code === 'EBLOCKED') return err as BlockedAddressError;
  return findBlockedCause((err as { cause?: unknown }).cause, depth + 1);
}

export type PublicFetchResponse = UndiciResponse;

/**
 * Rebinding-safe fetch for caller-supplied URLs. Performs the synchronous
 * checks up front (protocol, credentials, blocked hostnames, literal IPs) and
 * then validates the DNS answer *inside the socket's own lookup*, so the
 * address that passed the check is the one the socket connects to. With an
 * outbound proxy configured for Node ({@link envProxyFor}) the checked
 * address is the one the proxy tunnels to.
 *
 * Redirects are never followed automatically: a redirect target is a fresh
 * caller-supplied URL and must be passed back through this function so its
 * literal-IP / hostname checks run as well. Callers loop on 3xx themselves.
 *
 * Throws {@link DisallowedUrlError} when the URL is rejected either up front or
 * at connect time; any other failure propagates unchanged.
 */
export async function fetchPublicUrl(
  url: string,
  init: Omit<UndiciRequestInit, 'dispatcher' | 'redirect'> = {},
): Promise<PublicFetchResponse> {
  const parsed = parseAllowedUrl(url);
  if (!parsed) {
    throw new DisallowedUrlError(url);
  }
  const proxy = envProxyFor(parsed);

  try {
    return await undiciFetch(url, {
      ...init,
      redirect: 'manual',
      dispatcher: proxy ? getProxiedPublicDispatcher(proxy) : getPublicDispatcher(),
    });
  } catch (err) {
    const blocked = findBlockedCause(err);
    if (blocked) {
      throw new DisallowedUrlError(url, blocked);
    }
    throw err;
  }
}
