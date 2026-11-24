import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// #1546: an inline sidebar app's count (bulwark:app-badge) shows on its rail
// icon, styled like the Mail entry's and named with the app.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    key === 'name_unread' && params ? `${params.name}, ${params.count} unread` : key,
  useLocale: () => 'en',
}));
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/files',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { NavigationRail } = await import('../navigation-rail');
const { useUpdateStore } = await import('@/stores/update-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { useSidebarAppFramesStore } = await import('@/stores/sidebar-app-frames-store');

const chat = { id: 'chat', name: 'Chat', url: 'https://chat.example.com/', icon: 'Globe', openMode: 'inline' as const, showOnMobile: true };

beforeEach(() => {
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
  useSettingsStore.setState({ unreadCountStyle: 'count', sidebarApps: [chat] });
  useSidebarAppFramesStore.setState({
    frames: [{ id: chat.id, url: chat.url, name: chat.name }],
    shown: null,
    badges: {},
  });
});

const setBadge = (badge: { count: number; mentions?: number }) =>
  act(() => useSidebarAppFramesStore.getState().setBadge(chat.id, badge));

describe.each([
  ['collapsed rail', { orientation: 'vertical', collapsed: true }],
  ['expanded rail', { orientation: 'vertical', collapsed: false }],
  ['bottom bar', { orientation: 'horizontal', collapsed: false }],
] as const)('%s', (_name, props) => {
  const onInlineApp = vi.fn();

  it('shows the app\'s mentions as a number and says them with its name', () => {
    render(<NavigationRail {...props} onInlineApp={onInlineApp} />);
    expect(screen.queryByTestId('rail-app-count')).toBeNull();
    setBadge({ count: 9, mentions: 3 });
    const button = screen.getByRole('button', { name: 'Chat, 9 unread' });
    expect(button.querySelector('[data-testid="rail-app-count"]')?.textContent).toBe('3');
  });

  it('shows a dot for unread items without a mention', () => {
    render(<NavigationRail {...props} onInlineApp={onInlineApp} />);
    setBadge({ count: 2, mentions: 0 });
    expect(screen.getByTestId('rail-app-dot')).toBeInTheDocument();
    expect(screen.queryByTestId('rail-app-count')).toBeNull();
  });

  it('shows nothing when counts are hidden', () => {
    useSettingsStore.setState({ unreadCountStyle: 'hidden' });
    render(<NavigationRail {...props} onInlineApp={onInlineApp} />);
    setBadge({ count: 5 });
    expect(screen.queryByTestId('rail-app-count')).toBeNull();
    expect(screen.queryByTestId('rail-app-dot')).toBeNull();
  });
});
