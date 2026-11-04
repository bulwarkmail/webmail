import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationActionsHost } from '../notification-actions-host';

// The worker shows nothing for a login with email notifications off or do not
// disturb on. Each login has its own settings, so the answer goes per login.

const writeLoginQuiet = vi.fn(async (..._args: unknown[]) => {});
let state = { isAuthenticated: true, username: 'me@example.org' as string | null, emailNotificationsEnabled: true, doNotDisturb: false };

vi.mock('@/lib/push-preferences', () => ({ writeLoginQuiet: (...args: unknown[]) => writeLoginQuiet(...args), PUSH_STATE_CACHE: 'x' }));
vi.mock('@/lib/pwa-notify/worker-state', () => ({ writeNotificationActionPrefs: async () => {} }));
vi.mock('@/lib/pwa-notify/page-actions', () => ({ isNotificationActionRequest: () => false, runNotificationAction: async () => {} }));
vi.mock('@/lib/pwa-notify/plugin-veto', () => ({ pluginsMayVeto: () => false }));
vi.mock('@/lib/offline/offline-mode', () => ({ scheduleFlushAll: () => {} }));
vi.mock('@/lib/archive-gate', () => ({ useArchiveActionEnabled: () => false }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/stores/auth-store', () => ({ useAuthStore: (select: (s: typeof state) => unknown) => select(state) }));
vi.mock('@/stores/settings-store', () => ({
  useSettingsStore: (select: (s: typeof state & { archiveMode: string }) => unknown) => select({ ...state, archiveMode: 'single' }),
}));
vi.mock('@/stores/plugin-store', () => ({ usePluginStore: (select: (s: { plugins: unknown[] }) => unknown) => select({ plugins: [] }) }));
vi.mock('@/stores/account-store', () => {
  const useAccountStore = (select: (s: { accounts: unknown[] }) => unknown) => select({ accounts: [] });
  useAccountStore.getState = () => ({ accounts: [] });
  return { useAccountStore };
});

beforeEach(() => {
  writeLoginQuiet.mockClear();
  state = { isAuthenticated: true, username: 'me@example.org', emailNotificationsEnabled: true, doNotDisturb: false };
});

describe('what the page tells the worker about a login', () => {
  it('not quiet with everything on', () => {
    render(<NotificationActionsHost />);
    expect(writeLoginQuiet).toHaveBeenCalledWith('me@example.org', false);
  });

  it('quiet with email notifications off', () => {
    state.emailNotificationsEnabled = false;
    render(<NotificationActionsHost />);
    expect(writeLoginQuiet).toHaveBeenCalledWith('me@example.org', true);
  });

  it('quiet with do not disturb on', () => {
    state.doNotDisturb = true;
    render(<NotificationActionsHost />);
    expect(writeLoginQuiet).toHaveBeenCalledWith('me@example.org', true);
  });

  it('nothing while signed out', () => {
    state.isAuthenticated = false;
    state.username = null;
    render(<NotificationActionsHost />);
    expect(writeLoginQuiet).not.toHaveBeenCalled();
  });
});
