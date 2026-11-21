import { resolveTxt } from 'node:dns/promises';
import type { X509Certificate } from 'node:crypto';
import { fetchPublicUrl } from '@/lib/security/url-guard';
import { getRootDomain } from '@/lib/root-domain';
import { logger } from '@/lib/logger';
import { validateMarkCertificate, type MarkType } from './certificate';
import { dmarcAllowsBimi, pickBimiRecord, pickDmarcRecord } from './records';
import { bimiRoots } from './roots';
import { checkedSvg, rasterize, MAX_DRAWINGS, MAX_SELF_ASSERTED_BYTES } from './svg';

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
/**
 * Concurrent uncached lookups of signed-in callers; over it a domain is
 * simply missing for now. One caller may run a quarter of them
 * (RUNNING_PER_CALLER in lib/sender-icon-access.ts), so no one caller holds
 * them all.
 */
const MAX_IN_FLIGHT = 64;
/** How long a lookup waits for one of the MAX_DRAWINGS drawing slots. */
const DRAW_SLOT_WAIT_MS = 15_000;
/** How often the log says that the drawing process doesn't start; every lookup with a logo runs into it. */
const DRAWING_NOT_STARTED_WARN_MS = 60_000;

/*
 * Callers without a session (the mobile app's logo request, and whoever
 * else sends a request of that shape) are served from a pool of their own.
 * Signed-in callers take nothing from it and wait for nothing in it, so
 * however it is used, the mail view keeps its lookups, its drawings and
 * its cache.
 */
/**
 * Lookups started by callers without a session that run at once, all such
 * callers together. Protects the MAX_IN_FLIGHT lookups of signed-in users:
 * those are counted apart and never taken by a sessionless caller.
 */
export const SESSIONLESS_MAX_IN_FLIGHT = 4;
/**
 * Drawing slots (of MAX_DRAWINGS) such lookups hold at once; they also wait
 * while any signed-in lookup waits for a slot. Protects the drawing of the
 * logos signed-in users asked for.
 */
export const SESSIONLESS_MAX_DRAWINGS = 1;
/**
 * Answers kept for the names only sessionless callers asked about. Protects
 * the cache of CACHE_MAX answers that signed-in lookups fill: sessionless
 * callers read it and never write it, so they can't push an entry out of
 * it or replace one.
 */
export const SESSIONLESS_CACHE_MAX = 200;

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
/** The logo couldn't be drawn just now for reasons of this server's own: nothing to remember. */
class BusyError extends Error {}

/**
 * At most `max` holders at once; the others wait in turn, up to `waitMs`.
 * A slot is given back by the release function `acquire` resolves with, or
 * null when the wait ran out. Sessionless lookups hold at most
 * `sessionlessMax` of the slots, and get a free one only when no other
 * lookup waits for it.
 */
function drawingSlots(max: number, sessionlessMax: number, waitMs: number) {
  type Waiter = (release: () => void) => void;
  let running = 0;
  let sessionlessRunning = 0;
  const waiting: Waiter[] = [];
  const sessionlessWaiting: Waiter[] = [];
  const hold = (sessionless: boolean) => {
    running++;
    if (sessionless) sessionlessRunning++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      running--;
      if (sessionless) sessionlessRunning--;
      handOut();
    };
  };
  /** Free slots go to the waiting lookups of signed-in callers first. */
  const handOut = () => {
    while (running < max) {
      const next = waiting.shift();
      if (next) {
        next(hold(false));
        continue;
      }
      if (sessionlessRunning >= sessionlessMax) return;
      const sessionless = sessionlessWaiting.shift();
      if (!sessionless) return;
      sessionless(hold(true));
    }
  };
  return {
    acquire(sessionless = false): Promise<(() => void) | null> {
      const queue = sessionless ? sessionlessWaiting : waiting;
      return new Promise((resolve) => {
        const take: Waiter = (slot) => {
          clearTimeout(timer);
          resolve(slot);
        };
        const timer = setTimeout(() => {
          const at = queue.indexOf(take);
          if (at !== -1) queue.splice(at, 1);
          resolve(null);
        }, waitMs);
        queue.push(take);
        handOut();
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

export interface BimiAnswer {
  indicator: BimiIndicator | null;
  /**
   * The answer is "not now", not "no logo": no lookup could start for an
   * uncached domain (busy, or the caller's budget is spent), or the logo
   * couldn't be drawn because this server was busy. Nothing was remembered.
   */
  deferred: boolean;
}

export function createBimiResolver(overrides: Partial<BimiResolverDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const cache = new Map<string, CacheEntry>();
  const crlCache = new Map<string, { bytes: Uint8Array | null; expiresAt: number }>();
  const inFlight = new Map<string, Promise<BimiAnswer>>();
  // The same two for the lookups that callers without a session started.
  const sessionlessCache = new Map<string, CacheEntry>();
  const sessionlessInFlight = new Map<string, Promise<BimiAnswer>>();
  // Lookups of each kind that wait to hear whether their caller may start them.
  const asking = { signedIn: 0, sessionless: 0 };
  // Drawing is the expensive step; only a few run at once, whatever the
  // number of lookups waiting for one.
  const drawing = drawingSlots(MAX_DRAWINGS, SESSIONLESS_MAX_DRAWINGS, DRAW_SLOT_WAIT_MS);
  let drawingNotStartedWarnedAt = -Infinity;

  /** While the drawing process doesn't start, no sender has a logo: said as a warning, once per interval. */
  function drawingNotStarted(domain: string, reason: string) {
    const now = deps.now();
    if (now - drawingNotStartedWarnedAt < DRAWING_NOT_STARTED_WARN_MS) return;
    drawingNotStartedWarnedAt = now;
    logger.warn('BIMI logos are not shown: the process that draws them does not start', { domain, reason });
  }

  function remember(domain: string, indicator: BimiIndicator | null, ttl: number, sessionless: boolean) {
    const into = sessionless ? sessionlessCache : cache;
    const max = sessionless ? SESSIONLESS_CACHE_MAX : CACHE_MAX;
    into.delete(domain);
    // Map keeps insertion order: the first key is the oldest.
    while (into.size >= max) into.delete(into.keys().next().value!);
    into.set(domain, { indicator, expiresAt: deps.now() + ttl });
    // From now on the answer of the signed-in lookup is the one to serve.
    if (!sessionless) sessionlessCache.delete(domain);
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

  async function lookup(domain: string, sessionless: boolean): Promise<{ indicator: BimiIndicator | null; ttl: number }> {
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

    const checked = checkedSvg(svg, { strictProfile: indicator.status === 'self-asserted' });
    if (!checked.ok) {
      logger.debug('BIMI logo rejected', { domain, reason: checked.reason });
      return none;
    }
    // The certified logo goes through the same check above and the same
    // bounded drawing here. What is drawn is the checked document.
    const release = await drawing.acquire(sessionless);
    if (!release) throw new BusyError(`no free drawing slot for ${domain}`);
    let png: Buffer;
    try {
      png = await rasterize(checked.svg, { onStopped: release });
    } catch (err) {
      // A logo that fails to draw or draws past its own deadline is cached as
      // no logo like any other refused one. A drawing that didn't run its
      // course because of this server (it couldn't start, or the server was
      // too busy to hear back in time) says nothing about the logo.
      if ((err as { temporary?: unknown }).temporary === true) {
        if ((err as { neverStarted?: unknown }).neverStarted === true) drawingNotStarted(domain, (err as Error).message);
        throw new BusyError(`BIMI logo not drawn for ${domain}: ${(err as Error).message}`);
      }
      logger.debug('BIMI logo not drawn', { domain, reason: (err as Error).message });
      return none;
    }
    return { indicator: { ...indicator, png }, ttl };
  }

  /**
   * The indicator for a From domain, and whether the answer had to be put
   * off. Cached per domain; concurrent calls for one domain share a lookup.
   * A new lookup starts only when fewer than MAX_IN_FLIGHT run and
   * `mayStart` (asked only then) agrees; otherwise the answer is what the
   * cache had, `deferred`, and worth asking for again later.
   *
   * A `sessionless` caller is answered from what signed-in lookups cached
   * or have under way, and otherwise from the pool of its kind: at most
   * SESSIONLESS_MAX_IN_FLIGHT lookups, a cache of their own, one drawing
   * slot. A signed-in caller reads and waits for nothing in that pool.
   */
  async function answer(rawDomain: string, mayStart?: () => Promise<boolean>, sessionless = false): Promise<BimiAnswer> {
    const domain = normalizeBimiDomain(rawDomain);
    if (!domain) return { indicator: null, deferred: false };
    const fresh = (): CacheEntry | undefined => {
      const now = deps.now();
      const entry = cache.get(domain);
      if (entry && entry.expiresAt > now) return entry;
      const own = sessionless ? sessionlessCache.get(domain) : undefined;
      return own && own.expiresAt > now ? own : undefined;
    };
    const underWay = () => inFlight.get(domain) ?? (sessionless ? sessionlessInFlight.get(domain) : undefined);
    const kind = sessionless ? 'sessionless' : 'signedIn';
    const pool = sessionless ? sessionlessInFlight : inFlight;
    const poolMax = sessionless ? SESSIONLESS_MAX_IN_FLIGHT : MAX_IN_FLIGHT;

    const cached = fresh();
    if (cached) return { indicator: cached.indicator, deferred: false };
    const stale = (sessionless ? sessionlessCache.get(domain) : undefined) ?? cache.get(domain);
    const deferred = { indicator: stale?.indicator ?? null, deferred: true };
    const joined = underWay();
    if (joined) return joined;
    // A lookup that is asking `mayStart` keeps its place among the running
    // ones meanwhile, so a caller is only asked (and its budget only
    // charged) for a lookup that has room to run.
    if (pool.size + asking[kind] >= poolMax) return deferred;
    if (mayStart) {
      asking[kind]++;
      let allowed: boolean;
      try {
        allowed = await mayStart();
      } finally {
        asking[kind]--;
      }
      if (!allowed) return deferred;
    }
    // Another caller may have looked it up or started it meanwhile.
    const done = fresh();
    if (done) return { indicator: done.indicator, deferred: false };
    const pending = underWay();
    if (pending) return pending;
    if (pool.size >= poolMax) return deferred;

    const run = (async (): Promise<BimiAnswer> => {
      try {
        const { indicator, ttl } = await lookup(domain, sessionless);
        remember(domain, indicator, ttl, sessionless);
        return { indicator, deferred: false };
      } catch (err) {
        // The server was busy: nothing is remembered, and the answer is "not now".
        if (err instanceof BusyError) {
          logger.debug('BIMI logo put off', { domain, error: err.message });
          return deferred;
        }
        if (err instanceof TemporaryError) logger.debug('BIMI lookup failed, retrying later', { domain, error: err.message });
        else logger.warn('BIMI lookup failed', { domain, error: (err as Error).message });
        // Keep showing what we had; otherwise ask again after a short pause.
        const fallback = stale?.indicator ?? null;
        remember(domain, fallback, ERROR_TTL_MS, sessionless);
        return { indicator: fallback, deferred: false };
      } finally {
        pool.delete(domain);
      }
    })();
    pool.set(domain, run);
    return run;
  }

  /** The indicator for a From domain, or null. */
  async function resolve(rawDomain: string): Promise<BimiIndicator | null> {
    return (await answer(rawDomain)).indicator;
  }

  return { answer, resolve, clear: () => { cache.clear(); sessionlessCache.clear(); crlCache.clear(); } };
}

let shared: ReturnType<typeof createBimiResolver> | null = null;

export function bimiResolver() {
  if (!shared) shared = createBimiResolver();
  return shared;
}
