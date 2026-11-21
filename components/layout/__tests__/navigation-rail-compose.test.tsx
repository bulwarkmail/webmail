import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings > Appearance > Compose button: "Top of the navigation rail" puts
// Compose above the apps, on every page with the desktop rail.

const push = vi.hoisted(() => vi.fn());
vi.mock('../account-switcher', () => ({ AccountSwitcher: () => null }));
vi.mock('@/components/plugins/plugin-slot', () => ({ PluginSlot: () => null }));
vi.mock('@/components/keyboard-shortcuts-modal', () => ({ KeyboardShortcutsModal: () => null }));
vi.mock('@/components/search/search-box', () => ({ SearchBox: () => null }));
vi.mock('@/hooks/use-config', () => ({ useConfig: () => ({ appName: 'Mail' }) }));
vi.mock('@/hooks/use-stalwart-admin', () => ({ useStalwartAdmin: () => false }));
vi.mock('@/i18n/navigation', () => ({
  useRouter: () => ({ push, back: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/calendar',
  Link: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => <a href={href} {...rest}>{children}</a>,
}));

const { NavigationRail } = await import('../navigation-rail');
const { useUpdateStore } = await import('@/stores/update-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { consumePendingMailto } = await import('@/lib/protocol-handlers/session');

beforeEach(() => {
  push.mockReset();
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
  useSettingsStore.getState().resetToDefaults();
  consumePendingMailto();
});

const compose = () => screen.queryByRole('button', { name: 'compose' });

describe('Compose on the navigation rail', () => {
  it('is not there by default', () => {
    render(<NavigationRail orientation="vertical" collapsed onCompose={vi.fn()} />);
    expect(compose()).toBeNull();
  });

  it('heads the rail and opens the composer on the mail page', () => {
    useSettingsStore.getState().updateSetting('composePlacement', 'rail');
    const onCompose = vi.fn();
    render(<NavigationRail orientation="vertical" collapsed onCompose={onCompose} />);
    const button = compose()!;
    const mail = screen.getByRole('link', { name: 'mail' });
    expect(button.compareDocumentPosition(mail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(onCompose).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('goes to the mail page with a blank draft waiting from another page', () => {
    useSettingsStore.getState().updateSetting('composePlacement', 'rail');
    render(<NavigationRail orientation="vertical" collapsed />);
    fireEvent.click(compose()!);
    expect(push).toHaveBeenCalledWith('/');
    expect(consumePendingMailto()).toMatchObject({ to: [], cc: [], bcc: [], subject: '', inApp: true });
  });

  it('stays off the phone tab bar, the Pro rail and the admin rail', () => {
    useSettingsStore.getState().updateSetting('composePlacement', 'rail');
    const { unmount } = render(<NavigationRail orientation="horizontal" onCompose={vi.fn()} />);
    expect(compose()).toBeNull();
    unmount();
    const pro = render(<NavigationRail orientation="vertical" collapsed onNavigate={() => true} />);
    expect(compose()).toBeNull();
    pro.unmount();
    render(<NavigationRail orientation="vertical" collapsed adminActive />);
    expect(compose()).toBeNull();
  });

  it('stays off under Mountain View, which has its own Compose button', () => {
    useSettingsStore.setState({ composePlacement: 'rail', interfaceLayout: 'mountain-view' } as never);
    render(<NavigationRail orientation="vertical" collapsed onCompose={vi.fn()} />);
    expect(compose()).toBeNull();
  });
});
