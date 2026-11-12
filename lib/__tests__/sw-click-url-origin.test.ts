import { describe, expect, it, vi } from 'vitest';
import { FakeCaches, loadWorker } from './sw-harness';

// A click on a calendar reminder's notification opens `data.url`, the page the
// reminder was shown from (lib/calendar-reminders/system-notification.ts). The worker
// resolves it against its own origin and opens it only when it stays there; anything
// else opens the calendar. A browser reads a backslash in an http(s) address as a
// slash and drops tabs, so `/\host` and `/<tab>/host` name another site.

const ORIGIN = 'https://mail.example.com';

function clickOn(data: Record<string, unknown>) {
  const openWindow = vi.fn(async (_url: string) => null);
  const worker = loadWorker({ buildId: 'b', caches: new FakeCaches(), clients: [], openWindow });
  return worker
    .dispatch('notificationclick', { action: '', notification: { data, tag: 'calendar-reminder:x', close() {} } })
    .then(() => openWindow.mock.calls.map(([url]) => String(url)));
}

describe('a click on a calendar reminder notification', () => {
  it('opens the page the reminder names', async () => {
    expect(await clickOn({ kind: 'calendar-reminder', url: '/en/calendar' })).toEqual(['/en/calendar']);
  });

  it('keeps the query and the fragment of that page', async () => {
    expect(await clickOn({ kind: 'calendar-reminder', url: '/de/calendar?date=2026-11-12#event-1' })).toEqual(['/de/calendar?date=2026-11-12#event-1']);
  });

  it.each([
    '/\\evil.example/x',
    '/\\/evil.example/x',
    '/\t/evil.example/x',
    '//evil.example/x',
    'https://evil.example/x',
  ])('never leaves the origin for %j', async (url) => {
    const opened = await clickOn({ kind: 'calendar-reminder', url });
    expect(opened).toHaveLength(1);
    expect(new URL(opened[0], `${ORIGIN}/sw.js`).origin).toBe(ORIGIN);
  });

  it.each([
    ['a script address', 'javascript:alert(1)'],
    ['a data address', 'data:text/html,<p>x</p>'],
    ['a path that resolves to two slashes', '/x/..//evil.example/y'],
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { href: 'https://evil.example/' }],
    ['nothing', undefined],
  ])('opens the calendar for %s', async (_what, url) => {
    expect(await clickOn({ kind: 'calendar-reminder', url })).toEqual(['/calendar']);
  });
});
