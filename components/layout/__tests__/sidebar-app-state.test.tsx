import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// When an app's count cannot be trusted: "!" signed out, "?" offline (the last
// count greyed), unknown, or silent (an app of the policy with `badge: true`
// whose frame said nothing within SILENT_MS); the text in the tooltip and as a
// line at the top of the opened app; a signed-out or silent frame loaded anew
// when the user comes back to the window, a silent one also every
// SILENT_RELOAD_MS.

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params?.name !== undefined ? `${key}:${params.name}` : key,
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
const { SidebarAppFramesHost, RELOAD_GAP_MS } = await import('../sidebar-app-frames-host');
const { InlineAppView } = await import('../inline-app-view');
const { useUpdateStore } = await import('@/stores/update-store');
const { useSettingsStore } = await import('@/stores/settings-store');
const { usePolicyStore } = await import('@/stores/policy-store');
const { useAuthStore } = await import('@/stores/auth-store');
const { useSidebarAppFramesStore, SILENT_MS, SILENT_RELOAD_MS } = await import('@/stores/sidebar-app-frames-store');
type AppBadge = import('@/stores/sidebar-app-frames-store').AppBadge;

const CHAT = {
  id: 'admin-app-chat',
  name: 'Chat',
  url: 'https://chat.example.com/team',
  icon: 'MessageSquare',
  openMode: 'inline' as const,
  showOnMobile: true,
  badge: true,
};
const WIKI = { ...CHAT, id: 'admin-app-wiki', name: 'Wiki', url: 'https://wiki.example.com/', badge: false };

type State = 'ok' | 'signed-out' | 'offline' | 'unknown' | 'silent';
const badgeOf = (state: State, count: number, mentions: number): AppBadge =>
  state === 'ok' ? { count, mentions } : { count, mentions, state };
const report = (state: State, count = 0, mentions = 0, appId = CHAT.id) =>
  act(() => useSidebarAppFramesStore.getState().setBadge(appId, badgeOf(state, count, mentions)));

const frameOf = (app: { id: string; url: string; name: string }) => ({ id: app.id, url: app.url, name: app.name });

function openFrame(app: { id: string; url: string; name: string }) {
  act(() => useSidebarAppFramesStore.getState().open(frameOf(app), true));
  return screen.getByTitle(app.name) as HTMLIFrameElement;
}

function fromFrame(frame: HTMLIFrameElement, state: Exclude<State, 'silent'>, count = 0, mentions = 0) {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://chat.example.com',
      data: { type: 'bulwark:app-badge', version: 1, state, count, mentions },
    }));
  });
}

const ownState = (appId = CHAT.id) => {
  const badge = useSidebarAppFramesStore.getState().badges[appId];
  return badge ? (badge.state ?? 'ok') : undefined;
};

beforeEach(() => {
  useUpdateStore.setState({ startPolling: vi.fn() } as never);
  useSettingsStore.setState({ unreadCountStyle: 'count', keepAppsLoaded: true, sidebarApps: [] });
  usePolicyStore.setState((s) => ({
    loaded: true,
    policy: {
      ...s.policy,
      features: { ...s.policy.features, sidebarAppsEnabled: true },
      defaultSidebarApps: [CHAT, WIKI] as never,
    },
  }));
  useAuthStore.setState({ isAuthenticated: true });
  useSidebarAppFramesStore.setState({ frames: [], shown: null, badges: {} });
});

describe.each([
  ['collapsed rail', { orientation: 'vertical', collapsed: true }],
  ['expanded rail', { orientation: 'vertical', collapsed: false }],
  ['bottom bar', { orientation: 'horizontal', collapsed: false }],
] as const)('the mark in the %s', (_name, props) => {
  beforeEach(() => {
    useSidebarAppFramesStore.setState({ frames: [frameOf(CHAT), frameOf(WIKI)] });
  });

  it('is "!" signed out, with its text as the name and the tooltip', () => {
    render(<NavigationRail {...props} />);
    report('signed-out');
    const button = screen.getByRole('button', { name: 'app_signed_out:Chat' });
    expect(button.getAttribute('title')).toBe('app_signed_out:Chat');
    const mark = button.querySelector('[data-testid="rail-app-state"]')!;
    expect(mark.textContent).toBe('!');
    expect(mark.getAttribute('data-state')).toBe('signed-out');
    expect(screen.queryByTestId('rail-app-count')).toBeNull();
  });

  it('is "?" offline with the last count beside it, greyed', () => {
    render(<NavigationRail {...props} />);
    report('offline', 4, 2);
    const button = screen.getByRole('button', { name: 'app_offline:Chat' });
    expect(button.getAttribute('title')).toBe('app_offline:Chat');
    expect(screen.getByTestId('rail-app-state').textContent).toBe('2?');
    expect(screen.getByTestId('rail-app-state').className).toContain('bg-muted-foreground');
  });

  it.each([['unknown'], ['silent']] as const)('is "?" for %s', (state) => {
    render(<NavigationRail {...props} />);
    report(state, 4, 2);
    expect(screen.getByRole('button', { name: `app_${state}:Chat` }).getAttribute('title')).toBe(`app_${state}:Chat`);
    expect(screen.getByTestId('rail-app-state').textContent).toBe('?');
  });

  it('shows even with counts hidden, without the last count', () => {
    useSettingsStore.setState({ unreadCountStyle: 'hidden' });
    render(<NavigationRail {...props} />);
    report('offline', 4, 2);
    expect(screen.getByTestId('rail-app-state').textContent).toBe('?');
  });

  it('gives way to the count once the app reports ok again', () => {
    render(<NavigationRail {...props} />);
    report('signed-out');
    report('ok', 3, 1);
    expect(screen.queryByTestId('rail-app-state')).toBeNull();
    expect(screen.getByTestId('rail-app-count').textContent).toBe('1');
  });
});

describe('Mountain View\'s app menu', () => {
  it('draws the mark and says it', async () => {
    const { MvTopBar } = await import('../mv-top-bar');
    useSidebarAppFramesStore.setState({ frames: [frameOf(CHAT)] });
    render(<MvTopBar />);
    report('signed-out');
    fireEvent.click(screen.getByRole('button', { name: 'add_app' }));
    const item = screen.getByRole('menuitem', { name: 'app_signed_out:Chat' });
    expect(item.getAttribute('title')).toBe('app_signed_out:Chat');
    expect(item.querySelector('[data-testid="rail-app-state"]')?.textContent).toBe('!');
  });

  it('draws a count', async () => {
    const { MvTopBar } = await import('../mv-top-bar');
    useSidebarAppFramesStore.setState({ frames: [frameOf(CHAT)] });
    render(<MvTopBar />);
    report('ok', 5, 2);
    fireEvent.click(screen.getByRole('button', { name: 'add_app' }));
    const item = screen.getByRole('menuitem', { name: 'name_unread:Chat' });
    expect(item.querySelector('[data-testid="rail-app-count"]')?.textContent).toBe('2');
  });
});

describe('the line at the top of the opened app', () => {
  beforeEach(() => {
    useSidebarAppFramesStore.setState({ frames: [frameOf(CHAT), frameOf(WIKI)] });
  });
  const view = (app: { id: string; url: string; name: string }) =>
    render(<InlineAppView app={frameOf(app)} onClose={vi.fn()} />);

  it('says signed out and links to signing in, in a new tab', () => {
    view(CHAT);
    report('signed-out');
    expect(screen.getByRole('status').textContent).toContain('app_signed_out:Chat');
    const link = screen.getByRole('link', { name: 'app_sign_in' });
    expect(link.getAttribute('href')).toBe(CHAT.url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it.each([['offline'], ['unknown'], ['silent']] as const)('says %s, with no link', (state) => {
    view(CHAT);
    report(state, 3, 1);
    expect(screen.getByRole('status').textContent).toBe(`app_${state}:Chat`);
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('is not there while the count is current', () => {
    view(CHAT);
    report('ok', 3, 1);
    expect(screen.queryByTestId('app-state-line')).toBeNull();
  });
});

describe('silence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the app saying nothing within SILENT_MS of its frame\'s load', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    act(() => vi.advanceTimersByTime(SILENT_MS - 1));
    expect(ownState()).toBeUndefined();
    act(() => vi.advanceTimersByTime(1));
    expect(ownState()).toBe('silent');
    // Once it speaks, its word counts.
    fromFrame(frame, 'ok', 2, 1);
    expect(ownState()).toBe('ok');
  });

  it('is waited for from the frame\'s making too, should no load come (Firefox, a refused connection)', () => {
    render(<SidebarAppFramesHost />);
    openFrame(CHAT);
    act(() => vi.advanceTimersByTime(SILENT_MS));
    expect(ownState()).toBe('silent');
  });

  it('is not a quiet app that reported after its load, however long nothing changes or renders', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    fromFrame(frame, 'ok', 2, 1);
    openFrame(WIKI);
    openFrame(CHAT);
    act(() => vi.advanceTimersByTime(SILENT_MS * 10));
    expect(ownState()).toBe('ok');
  });

  it('keeps the last state while a frame loaded anew is heard from in time', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    fromFrame(frame, 'signed-out');
    fireEvent.load(frame);
    act(() => vi.advanceTimersByTime(SILENT_MS - 1));
    expect(ownState()).toBe('signed-out');
    fromFrame(frame, 'ok', 1, 0);
    act(() => vi.advanceTimersByTime(SILENT_MS));
    expect(ownState()).toBe('ok');
  });

  it('is not looked for in an app without badge: true', () => {
    render(<SidebarAppFramesHost />);
    fireEvent.load(openFrame(WIKI));
    act(() => vi.advanceTimersByTime(SILENT_MS * 2));
    expect(useSidebarAppFramesStore.getState().badges).toEqual({});
  });

  it('ends with the frame', () => {
    render(<SidebarAppFramesHost />);
    fireEvent.load(openFrame(CHAT));
    act(() => useSidebarAppFramesStore.getState().close(CHAT.id, false));
    act(() => vi.advanceTimersByTime(SILENT_MS * 2));
    expect(useSidebarAppFramesStore.getState().badges).toEqual({});
  });
});

describe('loading a frame anew', () => {
  let srcSet: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    srcSet = vi.spyOn(HTMLIFrameElement.prototype, 'src', 'set');
  });
  afterEach(() => {
    srcSet.mockRestore();
    vi.useRealTimers();
  });
  const focus = () => act(() => {
    window.dispatchEvent(new Event('focus'));
  });
  const loads = () => srcSet.mock.calls.filter((call: unknown[]) => call[0] === CHAT.url).length;

  it('signed out: when the window has the focus again, until the app says ok', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    fromFrame(frame, 'signed-out');
    srcSet.mockClear();
    focus();
    expect(loads()).toBe(1);
    // Not again at once (a focus and a visibility change come together).
    focus();
    expect(loads()).toBe(1);
    act(() => vi.advanceTimersByTime(RELOAD_GAP_MS));
    focus();
    expect(loads()).toBe(2);
    fromFrame(frame, 'ok', 1, 1);
    act(() => vi.advanceTimersByTime(RELOAD_GAP_MS));
    focus();
    expect(loads()).toBe(2);
  });

  it('not when the focus only comes back from the app\'s own frame', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    fromFrame(frame, 'signed-out');
    srcSet.mockClear();
    const active = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    act(() => {
      window.dispatchEvent(new Event('blur'));
      vi.advanceTimersByTime(1);
    });
    active.mockRestore();
    focus();
    expect(loads()).toBe(0);
  });

  it('when the tab is shown again', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    fromFrame(frame, 'signed-out');
    srcSet.mockClear();
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(loads()).toBe(1);
  });

  it('silent: every SILENT_RELOAD_MS and on the focus', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    act(() => vi.advanceTimersByTime(SILENT_MS));
    expect(ownState()).toBe('silent');
    srcSet.mockClear();
    act(() => vi.advanceTimersByTime(SILENT_RELOAD_MS));
    expect(loads()).toBe(1);
    act(() => vi.advanceTimersByTime(SILENT_RELOAD_MS));
    expect(loads()).toBe(2);
    // The focus right after a load: not again.
    focus();
    expect(loads()).toBe(2);
    act(() => vi.advanceTimersByTime(RELOAD_GAP_MS));
    focus();
    expect(loads()).toBe(3);
    // Heard from: no more.
    fromFrame(frame, 'ok', 0, 0);
    act(() => vi.advanceTimersByTime(SILENT_RELOAD_MS * 3));
    focus();
    expect(loads()).toBe(3);
  });

  it('never for offline or unknown (the app reconnects itself)', () => {
    render(<SidebarAppFramesHost />);
    const frame = openFrame(CHAT);
    fireEvent.load(frame);
    fromFrame(frame, 'offline', 2, 1);
    srcSet.mockClear();
    focus();
    fromFrame(frame, 'unknown');
    act(() => vi.advanceTimersByTime(RELOAD_GAP_MS));
    focus();
    expect(srcSet).not.toHaveBeenCalled();
  });
});
