import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '../types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';

/**
 * When the tray's summary is read again. The email store follows push only while the
 * mail view is mounted, so the summary listens to push and the local store itself: the
 * main window can sit in the tray on Calendar.
 */

vi.mock('@/lib/desktop/mail-notifications', () => ({ contentHiddenFor: () => false }));

const DELAY = 2000;
const own = { getAccountId: () => 'acc' } as unknown as IJMAPClient;
const other = { getAccountId: () => 'acc2' } as unknown as IJMAPClient;

async function start() {
  const { startOsSummary } = await import('../os-summary');
  const setSummary = vi.fn();
  window.bulwarkDesktop = { version: 1, platform: 'win32', os: { setSummary } } as unknown as BulwarkDesktopBridge;
  const handle = startOsSummary(() => 'en');
  await vi.advanceTimersByTimeAsync(DELAY + 10);
  setSummary.mockClear();
  return { handle, setSummary };
}

// The stores take a while to load the first time: not in the first test's time.
beforeAll(async () => {
  await Promise.all([import('../os-summary'), import('@/stores/email-store'), import('@/stores/calendar-store')]);
}, 60_000);

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  // Not signed in: the read is quick and empty, which is all these count.
  const { useAuthStore } = await import('@/stores/auth-store');
  useAuthStore.setState({ isAuthenticated: false, client: own as never, activeAccountId: null });
});

afterEach(() => {
  window.bulwarkDesktop = undefined;
  vi.useRealTimers();
});

describe('the tray summary', () => {
  it('is read again when push says the mail of the login in front changed, with nothing else on the page moving', async () => {
    const { emitPushStateChange } = await import('@/lib/push-events');
    const { handle, setSummary } = await start();
    emitPushStateChange({ changed: { acc: { Email: 's2', Mailbox: 'm2' } } } as never, own, 'active');
    await vi.advanceTimersByTimeAsync(DELAY + 10);
    expect(setSummary).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('not for another login, nor for a change that is not mail', async () => {
    const { emitPushStateChange } = await import('@/lib/push-events');
    const { handle, setSummary } = await start();
    emitPushStateChange({ changed: { acc2: { Email: 's2' } } } as never, other, 'background');
    emitPushStateChange({ changed: { acc: { CalendarEvent: 'c2' } } } as never, own, 'active');
    await vi.advanceTimersByTimeAsync(DELAY + 10);
    expect(setSummary).not.toHaveBeenCalled();
    handle.stop();
  });

  it("is read again when the local store has the new mail, which can come after the push", async () => {
    const { emitStoreEvent } = await import('@/lib/offline/store-events');
    const { handle, setSummary } = await start();
    emitStoreEvent({ type: 'created', account: 'x', jmap: 'acc', collection: 'Email', ids: ['a'] });
    await vi.advanceTimersByTimeAsync(DELAY + 10);
    expect(setSummary).toHaveBeenCalledTimes(1);
    emitStoreEvent({ type: 'changed', account: 'x', collections: ['Email'] });
    await vi.advanceTimersByTimeAsync(DELAY + 10);
    expect(setSummary).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('a burst is read once, and refresh(true) reads at once', async () => {
    const { emitPushStateChange } = await import('@/lib/push-events');
    const { handle, setSummary } = await start();
    for (let i = 0; i < 5; i += 1) emitPushStateChange({ changed: { acc: { Email: `s${i}` } } } as never, own, 'active');
    await vi.advanceTimersByTimeAsync(DELAY + 10);
    expect(setSummary).toHaveBeenCalledTimes(1);
    handle.refresh(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(setSummary).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it('lists the Inbox of a window that started on another page, where the email store has no folders', async () => {
    vi.useRealTimers();
    const { readSummary } = await import('../os-summary');
    const { useAuthStore } = await import('@/stores/auth-store');
    const { useAccountStore } = await import('@/stores/account-store');
    const { useEmailStore } = await import('@/stores/email-store');
    const { useCalendarStore } = await import('@/stores/calendar-store');
    const client = {
      getAccountId: () => 'acc',
      getAllMailboxes: vi.fn(async () => [{ id: 'in', role: 'inbox', name: 'Inbox' }]),
      getEmails: vi.fn(async () => ({ emails: [{ id: 'e1', threadId: 't1', subject: 'Budget draft', from: [{ name: 'Sam Ortega', email: 'sam@example.org' }] }], hasMore: false, total: 1 })),
    } as unknown as IJMAPClient;
    useAccountStore.setState({ accounts: [{ id: 'me@one', label: 'Me', username: 'me@example.org', email: 'me@example.org', serverUrl: 'https://one.example', cookieSlot: 0 }] as never });
    useAuthStore.setState({ isAuthenticated: true, client: client as never, activeAccountId: 'me@one' });
    useEmailStore.setState({ mailboxes: [] });
    useCalendarStore.setState({ supportsCalendar: false });
    const summary = await readSummary('en');
    expect(summary.unread.map((row) => `${row.sender}: ${row.subject}`)).toEqual(['Sam Ortega: Budget draft']);
    expect(client.getEmails).toHaveBeenCalledWith('in', undefined, 5, 0, undefined, false, { notKeyword: '$seen' });
  });

  it('hears nothing after it stopped', async () => {
    const { emitPushStateChange } = await import('@/lib/push-events');
    const { handle, setSummary } = await start();
    handle.stop();
    emitPushStateChange({ changed: { acc: { Email: 's2' } } } as never, own, 'active');
    await vi.advanceTimersByTimeAsync(DELAY + 10);
    expect(setSummary).not.toHaveBeenCalled();
  });
});
