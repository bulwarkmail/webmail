import { resolveTxt } from 'node:dns/promises';
import type { X509Certificate } from 'node:crypto';
import { fetchPublicUrl } from '@/lib/security/url-guard';
import { getRootDomain } from '@/lib/root-domain';
import { logger } from '@/lib/logger';
import { validateMarkCertificate, type MarkType } from './certificate';
import { dmarcAllowsBimi, pickBimiRecord, pickDmarcRecord } from './records';
import { bimiRoots } from './roots';
import { checkSvg, rasterize, MAX_DRAWINGS, MAX_SELF_ASSERTED_BYTES } from './svg';

/**
 * The receiver side of BIMI, which Stalwart doesn't do: for a From domain,
 * check its DMARC policy, find its assertion record, validate the mark
 * certificate when there is one, and turn the logo into a PNG.
 *
 * The caller decides whether the message itself passed DMARC; this only
 * answers per domain, so one lookup serves every message from it.
 */

export type BimiStatus = 'verified' | 'self-asserted';

export interface BimiIndicator {
  /** `verified`: a VMC or CMC backs the logo. `self-asserted`: only the DNS record does. */
  status: BimiStatus;
  png: Buffer;
  markType?: MarkType;
  organization?: string;
  issuer?: string;
}

const SELECTOR = 'default';
const MAX_PEM_BYTES = 128 * 1024;
const MAX_CRL_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL_MS = 6 * 60 * 60 * 1000;
/** After a DNS or network failure: try again soon rather than hide the logo for hours. */
const ERROR_TTL_MS = 10 * 60 * 1000;
const CRL_TTL_MS = 6 * 60 * 60 * 1000;
const CACHE_MAX = 2000;
const CRL_CACHE_MAX = 50;
/** Concurrent uncached lookups; over it a domain is simply missing for now. */
const MAX_IN_FLIGHT = 16;
/** How long a lookup waits for one of the MAX_DRAWINGS drawing slots. */
const DRAW_SLOT_WAIT_MS = 15_000;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** A host name we may look up: public-looking, lower case, no trailing dot. */
export function normalizeBimiDomain(domain: string | null | undefined): string | null {
  const lower = domain?.trim().toLowerCase().replace(/\.$/, '');
  if (!lower || lower.length > 253 || !DOMAIN_RE.test(lower)) return null;
  // Names a local resolver may answer for the LAN rather than the sender.
  if (/(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(lower)) return null;
  return lower;
}

class TemporaryError extends Error {}

/**
 * At most `max` holders at once; the others wait in turn, up to `waitMs`.
 * A slot is given back by the release function `acquire` resolves with, or
 * null when the wait ran out.
 */
function drawingSlots(max: number, waitMs: number) {
  let running = 0;
  const waiting: Array<(release: () => void) => void> = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next(once());
    else running--;
  };
  const once = () => {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      release();
    };
  };
  return {
    acquire(): Promise<(() => void) | null> {
      if (running < max) {
        running++;
        return Promise.resolve(once());
      }
      return new Promise((resolve) => {
        const take = (slot: () => void) => {
          clearTimeout(timer);
          resolve(slot);
        };
        const timer = setTimeout(() => {
          const at = waiting.indexOf(take);
          if (at !== -1) waiting.splice(at, 1);
          resolve(null);
        }, waitMs);
        waiting.push(take);
      });
    },
  };
}

export interface BimiResolverDeps {
  resolveTxt: (name: string) => Promise<string[][]>;
  /** GET a URL with a byte ceiling; null on 4xx/5xx, throws on network failure. */
  fetchBytes: (url: string, maxBytes: number, allowHttp: boolean) => Promise<Uint8Array | null>;
  roots: () => readonly X509Certificate[];
  now: () => number;
}

async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function defaultFetchBytes(url: string, maxBytes: number, allowHttp: boolean): Promise<Uint8Array | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) return null;
    // fetchPublicUrl refuses private addresses at connect time; the URLs
    // come from DNS records any sender controls.
    const get = () => fetchPublicUrl(current, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'User-Agent': 'Bulwark-Webmail-BIMI' },
    });
    let response: Awaited<ReturnType<typeof fetchPublicUrl>>;
    try {
      response = await get();
    } catch (err) {
      // Some logo hosts reset the first connection now and then (seen with
      // Valimail's); one more try saves showing no logo for ten minutes.
      if ((err as { cause?: { code?: string } }).cause?.code !== 'ECONNRESET') throw err;
      response = await get();
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) return null;
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    return readCapped(response.body as ReadableStream<Uint8Array> | null, maxBytes);
  }
  return null;
}

async function defaultResolveTxt(name: string): Promise<string[][]> {
  return resolveTxt(name);
}

const defaultDeps: BimiResolverDeps = {
  resolveTxt: defaultResolveTxt,
  fetchBytes: defaultFetchBytes,
  roots: bimiRoots,
  now: () => Date.now(),
};

interface CacheEntry {
  indicator: BimiIndicator | null;
  expiresAt: number;
}

export function createBimiResolver(overrides: Partial<BimiResolverDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const cache = new Map<string, CacheEntry>();
  const crlCache = new Map<string, { bytes: Uint8Array | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<BimiIndicator | null>>();
  // Drawing is the expensive step; only a few run at once, whatever the
  // number of lookups waiting for one.
  const drawing = drawingSlots(MAX_DRAWINGS, DRAW_SLOT_WAIT_MS);

  function remember(domain: string, indicator: BimiIndicator | null, ttl: number) {
    cache.delete(domain);
    // Map keeps insertion order: the first key is the oldest.
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
    cache.set(domain, { indicator, expiresAt: deps.now() + ttl });
  }

  async function txt(name: string): Promise<string[]> {
    try {
      return (await deps.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
      throw new TemporaryError(`DNS ${code ?? 'error'} for ${name}`);
    }
  }

  async function fetchCrl(url: string): Promise<Uint8Array | null> {
    const cached = crlCache.get(url);
    if (cached && cached.expiresAt > deps.now()) return cached.bytes;
    let bytes: Uint8Array | null = null;
    try {
      bytes = await deps.fetchBytes(url, MAX_CRL_BYTES, true);
    } catch {
      bytes = null;
    }
    while (crlCache.size >= CRL_CACHE_MAX) crlCache.delete(crlCache.keys().next().value!);
    // An unreachable CRL is asked for again after the error delay, not hours later.
    crlCache.set(url, { bytes, expiresAt: deps.now() + (bytes ? CRL_TTL_MS : ERROR_TTL_MS) });
    return bytes;
  }

  async function fetchText(url: string, maxBytes: number): Promise<string | null> {
    try {
      const bytes = await deps.fetchBytes(url, maxBytes, false);
      return bytes ? Buffer.from(bytes).toString('utf8') : null;
    } catch (err) {
      // undici reports "fetch failed" and keeps the reason in `cause`.
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      const reason = cause ? ` (${cause.code ?? cause.message})` : '';
      throw new TemporaryError(`fetch failed for ${url}: ${(err as Error).message}${reason}`);
    }
  }

  async function lookup(domain: string): Promise<{ indicator: BimiIndicator | null; ttl: number }> {
    const none = { indicator: null, ttl: NEGATIVE_TTL_MS };
    const organizational = getRootDomain(domain);
    const isSubdomain = organizational !== domain;

    const [authorDmarc, orgDmarc] = await Promise.all([
      txt(`_dmarc.${domain}`).then(pickDmarcRecord),
      isSubdomain ? txt(`_dmarc.${organizational}`).then(pickDmarcRecord) : Promise.resolve(null),
    ]);
    if (!dmarcAllowsBimi(authorDmarc, isSubdomain ? orgDmarc : authorDmarc, isSubdomain)) return none;

    // The author domain's record, else the organizational domain's. A record
    // that declines BIMI stops the search.
    let record = pickBimiRecord(await txt(`${SELECTOR}._bimi.${domain}`));
    if (!record && isSubdomain) record = pickBimiRecord(await txt(`${SELECTOR}._bimi.${organizational}`));
    if (!record || record.declined) return none;

    let svg: string | null;
    let indicator: Omit<BimiIndicator, 'png'>;
    let ttl = POSITIVE_TTL_MS;
    if (record.evidenceUrl) {
      const pem = await fetchText(record.evidenceUrl, MAX_PEM_BYTES);
      if (!pem) return none;
      const check = await validateMarkCertificate(pem, {
        domains: [...new Set([domain, organizational])],
        selector: SELECTOR,
        roots: deps.roots(),
        now: deps.now(),
        fetchCrl,
      });
      // An evidence document that doesn't validate fails BIMI outright; the
      // self-published logo next to it doesn't count instead.
      if (!check.ok) {
        logger.debug('BIMI certificate rejected', { domain, reason: check.reason });
        return none;
      }
      svg = check.mark.svg;
      indicator = {
        status: 'verified',
        markType: check.mark.markType,
        organization: check.mark.organization,
        issuer: check.mark.issuer,
      };
      ttl = Math.max(0, Math.min(ttl, check.mark.notAfter - deps.now()));
    } else {
      if (!record.logoUrl) return none;
      svg = await fetchText(record.logoUrl, MAX_SELF_ASSERTED_BYTES);
      if (!svg) return none;
      indicator = { status: 'self-asserted' };
    }

    const problem = checkSvg(svg, { strictProfile: indicator.status === 'self-asserted' });
    if (problem) {
      logger.debug('BIMI logo rejected', { domain, reason: problem });
      return none;
    }
    // The certified logo goes through the same check above and the same
    // bounded drawing here.
    const release = await drawing.acquire();
    if (!release) throw new TemporaryError(`no free drawing slot for ${domain}`);
    let png: Buffer;
    try {
      png = await rasterize(svg, { onStopped: release });
    } catch (err) {
      // A logo that fails to draw or draws past the deadline is cached as no
      // logo like any other refused one; a drawing that never started is
      // tried again soon.
      if ((err as { temporary?: unknown }).temporary === true) {
        throw new TemporaryError(`BIMI logo not drawn for ${domain}: ${(err as Error).message}`);
      }
      logger.debug('BIMI logo not drawn', { domain, reason: (err as Error).message });
      return none;
    }
    return { indicator: { ...indicator, png }, ttl };
  }

  /**
   * The indicator for a From domain, or null. Cached per domain; concurrent
   * calls for one domain share a lookup.
   */
  async function resolve(rawDomain: string): Promise<BimiIndicator | null> {
    const domain = normalizeBimiDomain(rawDomain);
    if (!domain) return null;
    const cached = cache.get(domain);
    if (cached && cached.expiresAt > deps.now()) return cached.indicator;
    const pending = inFlight.get(domain);
    if (pending) return pending;
    if (inFlight.size >= MAX_IN_FLIGHT) return cached?.indicator ?? null;

    const run = (async () => {
      try {
        const { indicator, ttl } = await lookup(domain);
        remember(domain, indicator, ttl);
        return indicator;
      } catch (err) {
        if (err instanceof TemporaryError) logger.debug('BIMI lookup failed, retrying later', { domain, error: err.message });
        else logger.warn('BIMI lookup failed', { domain, error: (err as Error).message });
        // Keep showing what we had; otherwise ask again after a short pause.
        const fallback = cached?.indicator ?? null;
        remember(domain, fallback, ERROR_TTL_MS);
        return fallback;
      } finally {
        inFlight.delete(domain);
      }
    })();
    inFlight.set(domain, run);
    return run;
  }

  return { resolve, clear: () => { cache.clear(); crlCache.clear(); } };
}

let shared: ReturnType<typeof createBimiResolver> | null = null;

export function bimiResolver() {
  if (!shared) shared = createBimiResolver();
  return shared;
}
