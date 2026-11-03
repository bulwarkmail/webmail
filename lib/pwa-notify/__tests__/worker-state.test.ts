import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeCaches } from '@/lib/__tests__/sw-harness';
import { PUSH_STATE_CACHE } from '@/lib/push-preferences';
import { consumePendingReplyText, notificationActionPrefsKey, pendingReplyKey, writeNotificationActionPrefs } from '../worker-state';

let caches: FakeCaches;

const keep = async (value: unknown) => {
  const cache = await caches.open(PUSH_STATE_CACHE);
  await cache.put(pendingReplyKey(window.location.origin), new Response(JSON.stringify(value)));
};

beforeEach(() => {
  caches = new FakeCaches();
  vi.stubGlobal('caches', caches);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the worker store', () => {
  it('holds the prefs where sw.js reads them', async () => {
    const prefs = { archiveEnabled: true, archiveMode: 'year' as const, pluginsMayVeto: true, labels: { archive: 'A', markRead: 'M', reply: 'R', replyPlaceholder: 'P' } };
    await writeNotificationActionPrefs(prefs);
    const cache = await caches.open(PUSH_STATE_CACHE);
    const stored = await cache.match(notificationActionPrefsKey(window.location.origin));
    expect(await stored!.json()).toEqual(prefs);
  });

  it('uses the same keys and cache as sw.js, which can import nothing', () => {
    const worker = readFileSync(join(process.cwd(), 'public', 'sw.js'), 'utf8');
    expect(worker).toContain(`const PUSH_STATE_CACHE = "${PUSH_STATE_CACHE}"`);
    expect(worker).toContain('/__push-state/actions`');
    expect(worker).toContain('/__push-state/pending-reply`');
    expect(notificationActionPrefsKey('https://x')).toBe('https://x/__push-state/actions');
    expect(pendingReplyKey('https://x')).toBe('https://x/__push-state/pending-reply');
  });

  it('survives a browser without the Cache API', async () => {
    vi.stubGlobal('caches', undefined);
    await expect(writeNotificationActionPrefs({ archiveEnabled: false, archiveMode: 'single', pluginsMayVeto: false, labels: { archive: '', markRead: '', reply: '', replyPlaceholder: '' } })).resolves.toBeUndefined();
    await expect(consumePendingReplyText('e1')).resolves.toBe('');
  });
});

describe('a reply typed on a notification', () => {
  it('reaches the page once', async () => {
    await keep({ emailId: 'e1', text: 'Thanks', at: Date.now() });
    expect(await consumePendingReplyText('e1')).toBe('Thanks');
    expect(await consumePendingReplyText('e1')).toBe('');
  });

  it("doesn't go into a reply to another message, and is gone after", async () => {
    await keep({ emailId: 'e1', text: 'Thanks', at: Date.now() });
    expect(await consumePendingReplyText('e2')).toBe('');
    expect(await consumePendingReplyText('e1')).toBe('');
  });

  it("doesn't go into a reply much later", async () => {
    await keep({ emailId: 'e1', text: 'Thanks', at: Date.now() - 6 * 60 * 1000 });
    expect(await consumePendingReplyText('e1')).toBe('');
  });

  it('is empty when there is none', async () => {
    expect(await consumePendingReplyText('e1')).toBe('');
  });
});
