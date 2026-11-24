import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { InlineAppView } from '../inline-app-view';
import { SidebarAppFramesHost } from '../sidebar-app-frames-host';
import { usePolicyStore } from '@/stores/policy-store';
import { useSettingsStore, type SidebarApp } from '@/stores/settings-store';
import { useAuthStore } from '@/stores/auth-store';
import { MAX_LIVE_APP_FRAMES, useSidebarAppFramesStore } from '@/stores/sidebar-app-frames-store';

const apps = [
  { id: 'a', url: 'https://a.example.com/', name: 'App A' },
  { id: 'b', url: 'https://b.example.com/', name: 'App B' },
];

const asSetting = (app: { id: string; url: string; name: string }): SidebarApp => ({
  ...app, icon: 'Globe', openMode: 'inline', showOnMobile: false,
});

const initialPolicy = usePolicyStore.getState().policy;

beforeEach(() => {
  useSidebarAppFramesStore.setState({ frames: [], shown: null });
  useSettingsStore.setState({ sidebarApps: apps.map(asSetting), keepAppsLoaded: true });
  usePolicyStore.setState({ policy: initialPolicy, loaded: true });
});

afterEach(() => {
  cleanup();
});

/** A page showing one app, beside the layout's frames. */
function Page({ app }: { app: (typeof apps)[number] | null }) {
  return (
    <>
      {app && <InlineAppView app={app} onClose={vi.fn()} />}
      <SidebarAppFramesHost />
    </>
  );
}

function open(app: (typeof apps)[number], keepOthers = true) {
  act(() => useSidebarAppFramesStore.getState().open(app, keepOthers));
}

// Until an app's frame has loaded it holds the initial about:blank, which a dark
// theme turns into an opaque white canvas in WebKit (#1517). Each frame stays
// invisible until its own first load, and stays visible after that.
describe('InlineAppView', () => {
  it('keeps a frame invisible until it has loaded', () => {
    open(apps[0]);
    render(<Page app={apps[0]} />);
    const frame = screen.getByTitle('App A');
    expect(frame).toHaveClass('invisible');
    fireEvent.load(frame);
    expect(frame).not.toHaveClass('invisible');
  });

  it('waits for each app on its own', () => {
    open(apps[0]);
    const { rerender } = render(<Page app={apps[0]} />);
    fireEvent.load(screen.getByTitle('App A'));
    open(apps[1]);
    rerender(<Page app={apps[1]} />);
    expect(screen.getByTitle('App B')).toHaveClass('invisible');
    expect(screen.getByTitle('App A')).toHaveClass('hidden');
    expect(screen.getByTitle('App A')).not.toHaveClass('invisible');
  });

  it('shows a loaded app again at once when it comes back', () => {
    open(apps[0]);
    const { rerender } = render(<Page app={apps[0]} />);
    fireEvent.load(screen.getByTitle('App A'));
    open(apps[1]);
    rerender(<Page app={apps[1]} />);
    fireEvent.load(screen.getByTitle('App B'));
    open(apps[0]);
    rerender(<Page app={apps[0]} />);
    const frame = screen.getByTitle('App A');
    expect(frame).not.toHaveClass('hidden');
    expect(frame).not.toHaveClass('invisible');
  });
});

// #1546: going from Mail to Calendar unmounted the app's frame with the page,
// and the app loaded again (a chat app's socket and session with it).
describe('frames across pages', () => {
  it('keeps the app\'s document when the page that showed it goes away', () => {
    open(apps[0]);
    const { rerender } = render(<Page app={apps[0]} />);
    const frame = screen.getByTitle('App A');
    fireEvent.load(frame);

    // Another page, with no app open.
    rerender(<Page app={null} />);
    expect(screen.getByTitle('App A')).toBe(frame);
    expect(frame.closest('[data-sidebar-app-frames]')).toHaveClass('hidden');

    // Opening it there shows the same frame, not a new one.
    open(apps[0]);
    rerender(<Page app={apps[0]} />);
    expect(screen.getByTitle('App A')).toBe(frame);
    expect(frame.closest('[data-sidebar-app-frames]')).not.toHaveClass('hidden');
    expect(frame).not.toHaveClass('invisible');
  });

  it('keeps only the open app with Keep apps loaded off, and drops it on close', () => {
    open(apps[0], false);
    open(apps[1], false);
    render(<Page app={apps[1]} />);
    expect(screen.queryByTitle('App A')).toBeNull();
    expect(screen.getByTitle('App B')).toBeInTheDocument();
    act(() => useSidebarAppFramesStore.getState().close('b', false));
    expect(screen.queryByTitle('App B')).toBeNull();
  });

  it(`keeps at most ${MAX_LIVE_APP_FRAMES} frames alive`, () => {
    const many = Array.from({ length: MAX_LIVE_APP_FRAMES + 1 }, (_, i) => ({
      id: `app-${i}`, url: `https://app${i}.example.com/`, name: `App ${i}`,
    }));
    useSettingsStore.setState({ sidebarApps: many.map(asSetting) });
    for (const app of many) open(app);
    render(<Page app={null} />);
    expect(screen.queryByTitle('App 0')).toBeNull();
    for (const app of many.slice(1)) expect(screen.getByTitle(app.name)).toBeInTheDocument();
  });

  it('drops the frame of an app removed from the rail', () => {
    open(apps[0]);
    render(<Page app={null} />);
    expect(screen.getByTitle('App A')).toBeInTheDocument();
    act(() => useSettingsStore.setState({ sidebarApps: [asSetting(apps[1])] }));
    expect(screen.queryByTitle('App A')).toBeNull();
  });

  it('drops every frame on sign-out', () => {
    act(() => useAuthStore.setState({ isAuthenticated: true } as never));
    open(apps[0]);
    render(<Page app={null} />);
    act(() => useAuthStore.setState({ isAuthenticated: false } as never));
    expect(screen.queryByTitle('App A')).toBeNull();
  });
});

// An app of the operator's policy gets downloads, dialogs and the features
// listed for it; a user's own app keeps the base sandbox (plan: rights per
// admin app, never a user's).
describe('InlineAppView frame rights', () => {
  const base = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';
  const chat = {
    id: 'admin-app-chat', name: 'Chat', url: 'https://chat.example.com/', icon: 'Globe',
    openMode: 'inline' as const, showOnMobile: false, allow: ['clipboard-write', 'camera'],
  };

  it('grants an app of the policy what the operator listed', () => {
    usePolicyStore.setState({ policy: { ...initialPolicy, defaultSidebarApps: [chat] as never } });
    const app = { id: chat.id, url: chat.url, name: chat.name };
    open(app);
    render(<Page app={app} />);
    const frame = screen.getByTitle('Chat');
    expect(frame).toHaveAttribute('sandbox', `${base} allow-downloads allow-modals`);
    expect(frame).toHaveAttribute('allow', 'clipboard-write https://chat.example.com; camera https://chat.example.com');
  });

  it('keeps a user\'s own app to the base sandbox', () => {
    usePolicyStore.setState({ policy: { ...initialPolicy, defaultSidebarApps: [chat] as never } });
    const app = { id: 'mine', url: chat.url, name: 'Mine' };
    useSettingsStore.setState({ sidebarApps: [asSetting(app)] });
    open(app);
    render(<Page app={app} />);
    const frame = screen.getByTitle('Mine');
    expect(frame).toHaveAttribute('sandbox', base);
    expect(frame).not.toHaveAttribute('allow');
  });
});
