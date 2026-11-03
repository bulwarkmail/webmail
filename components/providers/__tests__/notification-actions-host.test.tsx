import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginFingerprint } from '@/lib/pwa-notify/login-fingerprint';
import { NotificationActionsHost } from '../notification-actions-host';

// The tab's end of the service worker: it keeps the worker's copy of the
// labels and archive settings, runs notification buttons and flushes the
// outbox when the worker says so.

const writeNotificationActionPrefs = vi.fn(async (..._args: unknown[]) => {});
const runNotificationAction = vi.fn(async (_request: unknown, answer: (status: string) => void) => answer('done'));
const scheduleFlushAll = vi.fn();
let state = { isAuthenticated: true, archiveMode: 'month', archiveEnabled: true, plugins: [] as Array<Record<string, unknown>>, accounts: [] as Array<{ serverUrl: string; username: string }> };

vi.mock('@/lib/pwa-notify/worker-state', () => ({
  writeNotificationActionPrefs: (...args: unknown[]) => writeNotificationActionPrefs(...args),
}));
vi.mock('@/lib/pwa-notify/page-actions', async () => {
  const actual = await vi.importActual<typeof import('@/lib/pwa-notify/page-actions')>('@/lib/pwa-notify/page-actions');
  return { isNotificationActionRequest: actual.isNotificationActionRequest, runNotificationAction: (...args: Parameters<typeof runNotificationAction>) => runNotificationAction(...args) };
});
vi.mock('@/lib/offline/offline-mode', () => ({ scheduleFlushAll: (...args: unknown[]) => scheduleFlushAll(...args) }));
vi.mock('@/lib/archive-gate', () => ({ useArchiveActionEnabled: () => state.archiveEnabled }));
vi.mock('@/stores/auth-store', () => ({
  useAuthStore: (select: (s: { isAuthenticated: boolean }) => unknown) => select({ isAuthenticated: state.isAuthenticated }),
}));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (select: (s: { archiveMode: string }) => unknown) => select({ archiveMode: state.archiveMode }),
}));
vi.mock('@/stores/plugin-store', () => ({
  usePluginStore: (select: (s: { plugins: unknown[] }) => unknown) => select({ plugins: state.plugins }),
}));
vi.mock('@/stores/email-store', () => ({ useEmailStore: { getState: () => ({}) } }));
vi.mock('@/stores/account-store', () => {
  const useAccountStore = (select: (s: { accounts: unknown[] }) => unknown) => select({ accounts: state.accounts });
  useAccountStore.getState = () => ({ accounts: state.accounts });
  return { useAccountStore };
});

const worker = Object.assign(new EventTarget(), { controller: null as null | { postMessage: ReturnType<typeof vi.fn> } });
const fromWorker = (data: unknown, ports: unknown[] = []) => act(async () => {
  const event = new Event('message');
  Object.assign(event, { data, ports });
  worker.dispatchEvent(event);
});

beforeEach(() => {
  vi.clearAllMocks();
  state = { isAuthenticated: true, archiveMode: 'month', archiveEnabled: true, plugins: [], accounts: [] };
  worker.controller = null;
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: worker });
});

afterEach(() => {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
});

describe('the mirror for the worker', () => {
  it('writes the labels and archive settings once signed in', () => {
    render(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs).toHaveBeenCalledWith({
      archiveEnabled: true,
      archiveMode: 'month',
      pluginsMayVeto: false,
      labels: { archive: 'action_archive', markRead: 'action_mark_read', reply: 'action_reply', replyPlaceholder: 'reply_placeholder' },
    });
  });

  it('writes nothing while signed out', () => {
    state.isAuthenticated = false;
    render(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs).not.toHaveBeenCalled();
  });

  it('writes again on signing in, since signing out deleted the store', () => {
    state.isAuthenticated = false;
    const { rerender } = render(<NotificationActionsHost />);
    state.isAuthenticated = true;
    rerender(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs).toHaveBeenCalledTimes(1);
  });

  it('writes again when the archive mode or the gate changes, and not otherwise', () => {
    const { rerender } = render(<NotificationActionsHost />);
    rerender(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs).toHaveBeenCalledTimes(1);
    state.archiveMode = 'year';
    rerender(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs).toHaveBeenCalledTimes(2);
    state.archiveEnabled = false;
    rerender(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs).toHaveBeenCalledTimes(3);
    expect(writeNotificationActionPrefs.mock.calls[2][0]).toMatchObject({ archiveEnabled: false, archiveMode: 'year' });
  });
});

describe('what the worker hears about plugins and logins', () => {
  it('says when an enabled plugin may stop these actions, and when that ends', () => {
    state.plugins = [{ enabled: true, permissions: ['email:write'] }];
    const { rerender } = render(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs.mock.calls.at(-1)?.[0]).toMatchObject({ pluginsMayVeto: true });
    state.plugins = [{ enabled: false, permissions: ['email:write'] }];
    rerender(<NotificationActionsHost />);
    expect(writeNotificationActionPrefs.mock.calls.at(-1)?.[0]).toMatchObject({ pluginsMayVeto: false });
  });

  it('tells the worker which logins this tab holds, as their fingerprints', async () => {
    const postMessage = vi.fn();
    worker.controller = { postMessage };
    state.accounts = [{ serverUrl: 'https://one.example', username: 'alice@example.org' }];
    await act(async () => { render(<NotificationActionsHost />); });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalled());
    expect(postMessage).toHaveBeenCalledWith({
      type: 'client-logins',
      logins: [await loginFingerprint('https://one.example', 'alice@example.org')],
    });
  });

  it('tells it again when the logins change', async () => {
    const postMessage = vi.fn();
    worker.controller = { postMessage };
    state.accounts = [{ serverUrl: 'https://one.example', username: 'alice@example.org' }];
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<NotificationActionsHost />); });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(1));
    state.accounts = [];
    await act(async () => { view.rerender(<NotificationActionsHost />); });
    await vi.waitFor(() => expect(postMessage).toHaveBeenCalledTimes(2));
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'client-logins', logins: [] });
  });
});

describe('messages from the worker', () => {
  const request = { kind: 'notification-action', action: 'mark-read', emailId: 'e1', accountId: 'a', slot: 0, login: 'fp', at: Date.now() };

  it('runs a notification action and answers on its port', async () => {
    render(<NotificationActionsHost />);
    const port = { postMessage: vi.fn() };
    await fromWorker(request, [port]);
    expect(runNotificationAction.mock.calls[0][0]).toMatchObject({ action: 'mark-read', emailId: 'e1' });
    expect(port.postMessage).toHaveBeenCalledWith({ status: 'done' });
  });

  it('ignores anything else', async () => {
    render(<NotificationActionsHost />);
    await fromWorker({ kind: 'notificationclick', tag: 't' });
    await fromWorker({ ...request, action: 'delete' });
    await fromWorker(null);
    expect(runNotificationAction).not.toHaveBeenCalled();
    expect(scheduleFlushAll).not.toHaveBeenCalled();
  });

  it('flushes the outbox on the word of a sync event', async () => {
    render(<NotificationActionsHost />);
    await fromWorker({ kind: 'outbox-flush' });
    expect(scheduleFlushAll).toHaveBeenCalledWith(0);
  });

  it('stops listening when it goes', async () => {
    const { unmount } = render(<NotificationActionsHost />);
    unmount();
    await fromWorker({ kind: 'outbox-flush' });
    expect(scheduleFlushAll).not.toHaveBeenCalled();
  });

  it('does nothing in a browser without service workers', () => {
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined });
    expect(() => render(<NotificationActionsHost />)).not.toThrow();
  });
});
