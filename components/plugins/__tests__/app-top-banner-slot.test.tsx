import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The banner slot hands plugins `impersonated`, so a plugin like
// impersonation-notice can tell an admin's handoff session apart: since
// 1.11.1 its username is the plain mailbox, without the old `%master` part.
const slotProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('@/components/org/org-announcement', () => ({ OrgAnnouncement: () => <div data-testid="org-announcement" /> }));
vi.mock('@/components/plugins/plugin-slot', () => ({
  PluginSlot: ({ extraProps }: { extraProps: Record<string, unknown> }) => {
    slotProps.current = extraProps;
    return null;
  },
}));

import { AppTopBannerSlot } from '@/components/plugins/app-top-banner-slot';
import { EmbeddedContext } from '@/hooks/use-is-embedded';
import { useAccountStore } from '@/stores/account-store';
import { useAuthStore } from '@/stores/auth-store';

const account = {
  id: 'alice@x.test@mail.x.test', label: 'Alice', serverUrl: 'https://mail.x.test', username: 'alice@x.test',
  authMode: 'basic' as const, rememberMe: true, cookieSlot: 0, displayName: 'Alice', email: 'alice@x.test',
  isConnected: true, hasError: false, lastLoginAt: 1, avatarColor: '#000000', isDefault: true,
};

describe('AppTopBannerSlot', () => {
  beforeEach(() => {
    slotProps.current = null;
    useAuthStore.setState({ username: 'alice@x.test', serverUrl: 'https://mail.x.test' });
  });

  it('tells plugins the session is an impersonation', () => {
    useAccountStore.setState({ accounts: [{ ...account, impersonated: true }], activeAccountId: account.id });
    render(<AppTopBannerSlot />);
    expect(slotProps.current).toEqual({ username: 'alice@x.test', serverUrl: 'https://mail.x.test', impersonated: true });
  });

  it('says false for a session the user opened themselves', () => {
    useAccountStore.setState({ accounts: [account], activeAccountId: account.id });
    render(<AppTopBannerSlot />);
    expect(slotProps.current?.impersonated).toBe(false);
  });

  it('shows the organisation announcement above the plugin banners', () => {
    useAccountStore.setState({ accounts: [account], activeAccountId: account.id });
    render(<AppTopBannerSlot />);
    expect(screen.getByTestId('org-announcement')).toBeTruthy();
  });

  it('leaves the announcement to the Pro shell, which shows it once for all its panes', () => {
    useAccountStore.setState({ accounts: [account], activeAccountId: account.id });
    render(<EmbeddedContext.Provider value={true}><AppTopBannerSlot /></EmbeddedContext.Provider>);
    expect(screen.queryByTestId('org-announcement')).toBeNull();
  });
});
