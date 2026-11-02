// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { bundleCacheSize, cacheBundle, clearBundleCache, getCachedBundle, MAX_BYTES } from '../bundle-cache';

// The per-replica bundle cache (#1066) must stay under its 64 MB cap and
// drop the bundle used longest ago first.

beforeEach(() => clearBundleCache());

const big = (c: string) => c.repeat(20 * 1024 * 1024);

describe('bundle cache', () => {
  it('drops the least recently used bundle once it holds more than the cap', () => {
    cacheBundle('a', big('a'));
    cacheBundle('b', big('b'));
    cacheBundle('c', big('c'));
    expect(getCachedBundle('a')).toBeTruthy(); // a is now the most recently used
    cacheBundle('d', big('d'));

    expect(getCachedBundle('b')).toBeUndefined();
    expect(getCachedBundle('a')?.code[0]).toBe('a');
    expect(getCachedBundle('c')).toBeTruthy();
    expect(getCachedBundle('d')).toBeTruthy();
    expect(bundleCacheSize().bytes).toBeLessThanOrEqual(MAX_BYTES);
  });

  it('keeps a signature learned later with the bundle', () => {
    cacheBundle('h', 'code()');
    getCachedBundle('h')!.signature = 'sig';
    cacheBundle('h', 'code()');
    expect(getCachedBundle('h')).toMatchObject({ code: 'code()', signature: 'sig' });
  });
});
