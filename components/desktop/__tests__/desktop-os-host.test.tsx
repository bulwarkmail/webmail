import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BulwarkDesktopBridge } from '@/lib/desktop/types';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';
import { useSettingsStore } from '@/stores/settings-store';

/** The main window's OS host: which logins get a new-mail baseline, and when the tray's summary is read again. */

const intl = vi.hoisted(() => ({ locale: 'en' }));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => intl.locale,
}));
vi.mock('@/lib/archive-gate', () => ({ useArchiveActionEnabled: () => true }));
vi.mock('@/lib/desktop/power', () => ({ startPowerWatch: () => () => {} }));

const mail = vi.hoisted(() => ({ seed: vi.fn(), setLabels: vi.fn(), stop: vi.fn(), noteCreated: vi.fn() }));
vi.mock('@/lib/desktop/mail-notifications', () => ({ startMailNotifications: () => mail, contentHiddenFor: () => false }));
const summary = vi.hoisted(() => ({ refresh: vi.fn(), stop: vi.fn() }));
vi.mock('@/lib/desktop/os-summary', () => ({ startOsSummary: () => summary }));

const { DesktopOsHost } = await import('../desktop-os-host');

const clients = new Map<string, IJMAPClient>();
const fake = (name: string) => ({ name }) as unknown as IJMAPClient;
const entry = (id: string) => ({ id, label: id, username: `${id}@example.org`, email: `${id}@example.org` });

beforeEach(() => {
  vi.clearAllMocks();
  intl.locale = 'en';
  clients.clear();
  window.bulwarkDesktop = { version: 1, platform: 'win32', os: { setLocked: vi.fn() } } as unknown as BulwarkDesktopBridge;
  useSettingsStore.setState({ timeFormat: '24h' });
  useAccountStore.setState({ accounts: [entry('work'), entry('home')] as never });
  useAuthStore.setState({
    isAuthenticated: true,
    client: null,
    activeAccountId: 'home',
    connectedAccountsRevision: 0,
    getClientForAccount: (id: string) => clients.get(id) as never,
  } as never);
});

afterEach(() => {
  cleanup();
  window.bulwarkDesktop = undefined;
});

describe('new-mail baselines', () => {
  it('a login that connects after the window is up gets one too, as after a restart', () => {
    const home = fake('home');
    clients.set('home', home);
    useAuthStore.setState({ client: home as never });
    render(<DesktopOsHost />);
    expect(mail.seed.mock.calls.map(([client]) => client)).toEqual([home]);

    // The other login, restored in the background: same accounts, one more connection.
    const work = fake('work');
    clients.set('work', work);
    act(() => useAuthStore.setState((state) => ({ connectedAccountsRevision: state.connectedAccountsRevision + 1 })));
    expect(mail.seed.mock.calls.map(([client]) => client)).toContain(work);
  });
});

describe('the tray summary', () => {
  it('is read again at once when the language or the time format changes', () => {
    const view = render(<DesktopOsHost />);
    summary.refresh.mockClear();
    intl.locale = 'de';
    view.rerender(<DesktopOsHost />);
    expect(summary.refresh).toHaveBeenCalledWith(true);

    summary.refresh.mockClear();
    act(() => useSettingsStore.setState({ timeFormat: '12h' }));
    expect(summary.refresh).toHaveBeenCalledWith(true);
  });

  it('not on a render that changed neither', () => {
    const view = render(<DesktopOsHost />);
    summary.refresh.mockClear();
    view.rerender(<DesktopOsHost />);
    expect(summary.refresh).not.toHaveBeenCalledWith(true);
  });
});
