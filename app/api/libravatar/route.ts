import { NextRequest, NextResponse } from 'next/server';
import { resolveSrv } from 'node:dns/promises';
import {
  EMAIL_RE,
  emailHash,
  emailDomain,
  clampSize,
  isPublicHost,
  buildAvatarUrl,
  type SrvTarget,
} from '@/lib/libravatar';

// Libravatar avatar resolver (https://www.libravatar.org/).
//
// Federated, privacy-friendly Gravatar alternative. For an email address we:
//   1. hash the normalised address (SHA-256, per the Libravatar spec),
//   2. look up the domain's `_avatars-sec._tcp.<domain>` (https) SRV record;
//      if a federated server is published we fetch the avatar from THERE
//      (so self-hosted mail servers serve their own users' photos),
//   3. otherwise fall back to the central seccdn.libravatar.org.
// `d=404` means "no image → 404" so the <Avatar> component can fall back to
// the sender favicon / initials instead of a default silhouette.
//
// All fetches happen server-side (DNS SRV isn't available in the browser),
// behind the same SSRF guards + LRU cache as the favicon proxy.

const CACHE_MAX_SIZE = 2000;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks
const NEGATIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const NEGATIVE_CACHE_MAX_SIZE = 4000;
const SRV_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const FETCH_TIMEOUT_MS = 5000;
const MAX_BYTES = 256 * 1024; // avatars are small; bound memory

interface CacheEntry {
  data: ArrayBuffer;
  contentType: string;
  fetchedAt: number;
}
const cache = new Map<string, CacheEntry>();
const negativeCache = new Map<string, { fetchedAt: number }>();
const srvCache = new Map<string, { target: SrvTarget | null; fetchedAt: number }>();

function pruneCache<T>(map: Map<string, T>, max: number) {
  if (map.size <= max) return;
  const drop = Math.ceil(max * 0.1);
  let i = 0;
  for (const k of map.keys()) {
    map.delete(k);
    if (++i >= drop) break;
  }
}

// Resolve the Libravatar federation target for a domain via the
// `_avatars-sec._tcp.<domain>` (https) SRV record. null → use the central CDN.
async function resolveFederatedTarget(domain: string): Promise<SrvTarget | null> {
  const cached = srvCache.get(domain);
  if (cached && Date.now() - cached.fetchedAt < SRV_CACHE_TTL_MS) return cached.target;
  let target: SrvTarget | null = null;
  try {
    const records = await resolveSrv(`_avatars-sec._tcp.${domain}`);
    const usable = records
      .filter((r) => r.name && isPublicHost(r.name) && r.port > 0 && r.port <= 65535)
      .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
    if (usable.length > 0) target = { host: usable[0].name, port: usable[0].port };
  } catch {
    target = null;
  }
  if (srvCache.size >= 1000) srvCache.clear();
  srvCache.set(domain, { target, fetchedAt: Date.now() });
  return target;
}

export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get('email');
  const size = clampSize(req.nextUrl.searchParams.get('s'));

  if (!email) return new NextResponse('Missing email', { status: 400 });
  if (!EMAIL_RE.test(email)) return new NextResponse('Invalid email', { status: 400 });

  const domain = emailDomain(email)!;
  const hash = emailHash(email);
  const cacheKey = `${hash}:${size}`;

  const neg = negativeCache.get(cacheKey);
  if (neg && Date.now() - neg.fetchedAt < NEGATIVE_CACHE_TTL_MS) {
    return new NextResponse(null, { status: 404 });
  }
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.fetchedAt < CACHE_TTL_MS) {
    return new NextResponse(hit.data, {
      status: 200,
      headers: { 'Content-Type': hit.contentType, 'Cache-Control': 'public, max-age=86400' },
    });
  }

  const target = await resolveFederatedTarget(domain);
  const url = buildAvatarUrl(target, hash, size);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: 'image/*' },
    });
    const contentType = upstream.headers.get('content-type') || '';
    if (!upstream.ok || !contentType.startsWith('image/')) {
      negativeCache.set(cacheKey, { fetchedAt: Date.now() });
      pruneCache(negativeCache, NEGATIVE_CACHE_MAX_SIZE);
      return new NextResponse(null, { status: 404 });
    }
    const buf = await upstream.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > MAX_BYTES) {
      negativeCache.set(cacheKey, { fetchedAt: Date.now() });
      return new NextResponse(null, { status: 404 });
    }
    cache.set(cacheKey, { data: buf, contentType, fetchedAt: Date.now() });
    pruneCache(cache, CACHE_MAX_SIZE);
    return new NextResponse(buf, {
      status: 200,
      headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=86400' },
    });
  } catch {
    negativeCache.set(cacheKey, { fetchedAt: Date.now() });
    pruneCache(negativeCache, NEGATIVE_CACHE_MAX_SIZE);
    return new NextResponse(null, { status: 404 });
  } finally {
    clearTimeout(timer);
  }
}
