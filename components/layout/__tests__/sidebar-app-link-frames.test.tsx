import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineAppView } from '../inline-app-view';
import { SidebarAppFramesHost } from '../sidebar-app-frames-host';
import { useSidebarApps } from '@/hooks/use-sidebar-apps';
import { EmbeddedContext } from '@/hooks/use-is-embedded';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore, type SidebarApp } from '@/stores/settings-store';
import { useSidebarAppFramesStore, type LiveAppFrame } from '@/stores/sidebar-app-frames-store';
import { APP_FRAME_ORIGINS_COOKIE } from '@/lib/security/app-frame-origins';

// A link to an app: the newest page mounted that can show apps shows it, and
// the app's one frame goes to the link's address.

const A: LiveAppFrame = { id: 'a', url: 'https://a.example.com/', name: 'App A' };
const POST = 'https://a.example.com/team/pl/abc';

const asSetting = (app: LiveAppFrame): SidebarApp => ({
  id: app.id, url: app.url, name: app.name, icon: 'Globe', openMode: 'inline', showOnMobile: false,
});

let opener: ReturnType<typeof useSidebarApps> | null = null;

function Page() {
  const apps = useSidebarApps();
  opener = apps;
  return (
    <div data-testid="page">
      {apps.inlineApp && <InlineAppView app={apps.inlineApp} onClose={apps.closeInlineApp} />}
    </div>
  );
}

function Layout() {
  return (
    <>
      <Page />
      <SidebarAppFramesHost />
    </>
  );
}

const host = () => useSidebarAppFramesStore.getState().hosts.at(-1)!;
const link = (url: string) =>
  act(() => {
    host().show(useSidebarAppFramesStore.getState().openAt(A, url, useSettingsStore.getState().keepAppsLoaded));
  });
const open = () => act(() => opener!.handleInlineApp(A.id, A.url, A.name));

beforeEach(() => {
  document.cookie = `${APP_FRAME_ORIGINS_COOKIE}=${encodeURIComponent('https://a.example.com')}; path=/`;
  useSettingsStore.setState({ sidebarApps: [asSetting(A)], keepAppsLoaded: false });
  usePolicyStore.setState({ loaded: true });
  useSidebarAppFramesStore.setState({ frames: [], shown: null, badges: {}, hosts: [] });
  opener = null;
});

describe('openAt', () => {
  it('makes the frame at the link and shows it in the page', () => {
    render(<Layout />);
    link(POST);
    expect(screen.getByTitle('App A')).toHaveAttribute('src', POST);
    expect(opener!.inlineApp?.id).toBe('a');
    expect(screen.getByRole('heading', { name: 'App A' })).toBeInTheDocument();
  });

  it('takes a frame kept loaded to the link, the same frame', () => {
    useSettingsStore.setState({ keepAppsLoaded: true });
    render(<Layout />);
    open();
    const frame = screen.getByTitle('App A');
    act(() => opener!.closeInlineApp());
    link(POST);
    expect(screen.getByTitle('App A')).toBe(frame);
    expect(frame).toHaveAttribute('src', POST);
    expect(opener!.inlineApp?.id).toBe('a');
  });

  it('sends the frame to the address again on a second click of the same link', () => {
    render(<Layout />);
    link(POST);
    const frame = screen.getByTitle('App A') as HTMLIFrameElement;
    const set = vi.spyOn(frame, 'src', 'set');
    link(POST);
    expect(set).toHaveBeenCalledWith(POST);
    expect(screen.getByTitle('App A')).toBe(frame);
  });

  it('opening the app kept loaded from the rail afterwards keeps where the link took it', () => {
    useSettingsStore.setState({ keepAppsLoaded: true });
    render(<Layout />);
    link(POST);
    const frame = screen.getByTitle('App A');
    act(() => opener!.closeInlineApp());
    expect(opener!.inlineApp).toBeNull();
    open();
    expect(screen.getByTitle('App A')).toBe(frame);
    expect(frame).toHaveAttribute('src', POST);
  });

  it('opening the app from the rail after it was closed starts it at its own address', () => {
    render(<Layout />);
    link(POST);
    act(() => opener!.closeInlineApp());
    open();
    expect(screen.getByTitle('App A')).toHaveAttribute('src', A.url);
  });

  it('counts only pages not embedded in another as places to show an app', () => {
    render(
      <>
        <Page />
        <EmbeddedContext.Provider value><Page /></EmbeddedContext.Provider>
      </>,
    );
    expect(useSidebarAppFramesStore.getState().hosts).toHaveLength(1);
  });

  it('forgets a page that is gone', () => {
    const { unmount } = render(<Layout />);
    expect(useSidebarAppFramesStore.getState().hosts).toHaveLength(1);
    unmount();
    expect(useSidebarAppFramesStore.getState().hosts).toHaveLength(0);
  });
});
